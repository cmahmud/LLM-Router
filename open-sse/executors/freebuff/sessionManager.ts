import { createHash } from "node:crypto";

import type { FreebuffClient } from "./client.ts";
import {
  FreebuffClientError,
  freebuffAdmissionError,
} from "./errors.ts";
import type { FreebuffAdmission } from "./types.ts";

export type FreebuffSessionClient = Pick<
  FreebuffClient,
  "getSession" | "admitSession" | "releaseSession"
>;

type OwnedSession = {
  instanceId: string;
  model: string;
  expiresAtMs?: number;
  token: string;
  client: FreebuffSessionClient;
};

type SessionRecord = {
  owned?: OwnedSession;
  leaseCount: number;
  inFlight?: Promise<OwnedSession>;
  inFlightModel?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  cleanupPromise?: Promise<void>;
};

export type FreebuffSessionLease = {
  accountKey: string;
  instanceId: string;
  model: string;
  release: () => Promise<void>;
};

export type FreebuffSessionManagerOptions = {
  idleReleaseMs?: number;
  now?: () => number;
};

const DEFAULT_IDLE_RELEASE_MS = 60_000;

export function freebuffCredentialKey(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function sessionInstanceId(value: FreebuffAdmission): string | undefined {
  const candidate = (value as Record<string, unknown>).instanceId;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function sessionExpiresAtMs(value: FreebuffAdmission): number | undefined {
  const candidate = (value as Record<string, unknown>).expiresAt;
  if (typeof candidate !== "string") return undefined;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function abortedError(): FreebuffClientError {
  return new FreebuffClientError("Freebuff session acquisition was aborted", {
    status: 499,
    kind: "aborted",
  });
}

function closedError(): FreebuffClientError {
  return new FreebuffClientError("Freebuff session manager is shutting down", {
    status: 503,
    kind: "upstream",
  });
}

function conflictError(message: string): FreebuffClientError {
  return new FreebuffClientError(message, {
    status: 409,
    kind: "upstream",
  });
}

function isAmbiguousAdmissionError(error: unknown): error is FreebuffClientError {
  return (
    error instanceof FreebuffClientError &&
    (error.kind === "network" ||
      error.kind === "timeout" ||
      (error.kind === "upstream" && error.status >= 500))
  );
}

async function waitForShared<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortedError();

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortedError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

export class FreebuffSessionManager {
  private readonly records = new Map<string, SessionRecord>();
  private readonly idleReleaseMs: number;
  private readonly now: () => number;
  private epoch = 0;
  private closed = false;

  constructor(options: FreebuffSessionManagerOptions = {}) {
    this.idleReleaseMs = options.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
    this.now = options.now ?? Date.now;
  }

  async acquire(params: {
    client: FreebuffSessionClient;
    token: string;
    model: string;
    signal?: AbortSignal | null;
  }): Promise<FreebuffSessionLease> {
    if (this.closed) throw closedError();
    if (params.signal?.aborted) throw abortedError();

    const accountKey = freebuffCredentialKey(params.token);
    const record = this.records.get(accountKey) ?? { leaseCount: 0 };
    if (!this.records.has(accountKey)) this.records.set(accountKey, record);
    this.clearIdleTimer(record);

    if (record.inFlight) {
      if (record.inFlightModel !== params.model) {
        throw conflictError(
          "Freebuff session transition is already in progress for a different model"
        );
      }
      const owned = await waitForShared(record.inFlight, params.signal);
      return this.createLease(accountKey, record, owned);
    }

    if (record.owned) {
      if (record.owned.model !== params.model) {
        if (record.leaseCount > 0) {
          throw conflictError(
            "Cannot switch the Freebuff model while the owned session is leased"
          );
        }
        const owned = await waitForShared(
          this.beginTransition(record, params.model, async () => {
            await this.releaseOwned(record);
            return this.establishSession(
              params.client,
              params.token,
              params.model
            );
          }),
          params.signal
        );
        return this.createLease(accountKey, record, owned);
      }

      if (
        record.owned.expiresAtMs !== undefined &&
        record.owned.expiresAtMs <= this.now()
      ) {
        const owned = await waitForShared(
          this.beginTransition(record, params.model, () =>
            this.reconcileExpiredSession(
              record,
              params.client,
              params.token,
              params.model
            )
          ),
          params.signal
        );
        return this.createLease(accountKey, record, owned);
      }

      return this.createLease(accountKey, record, record.owned);
    }

    const owned = await waitForShared(
      this.beginTransition(record, params.model, () =>
        this.establishSession(params.client, params.token, params.model)
      ),
      params.signal
    );
    return this.createLease(accountKey, record, owned);
  }

  private beginTransition(
    record: SessionRecord,
    model: string,
    operation: () => Promise<OwnedSession>
  ): Promise<OwnedSession> {
    const operationEpoch = this.epoch;
    const promise = (async () => {
      const owned = await operation();
      if (this.closed || this.epoch !== operationEpoch) {
        void owned.client
          .releaseSession(owned.token, owned.instanceId)
          .catch(() => {});
        throw closedError();
      }
      record.owned = owned;
      if (record.leaseCount === 0) {
        await this.scheduleIdleRelease(record);
      }
      return owned;
    })();

    record.inFlight = promise;
    record.inFlightModel = model;
    void promise.finally(() => {
      if (record.inFlight === promise) {
        record.inFlight = undefined;
        record.inFlightModel = undefined;
      }
    }).catch(() => {});
    return promise;
  }

  private async establishSession(
    client: FreebuffSessionClient,
    token: string,
    model: string
  ): Promise<OwnedSession> {
    const current = await client.getSession(token);

    if (current.status === "active") {
      throw conflictError(
        "A Freebuff session is already active upstream and is unowned by this router process"
      );
    }
    if (current.status === "ended" && sessionInstanceId(current)) {
      throw conflictError(
        "A Freebuff session is still draining upstream and cannot be taken over"
      );
    }
    if (current.status !== "none" && current.status !== "ended") {
      throw freebuffAdmissionError(current.status, current.retryAfterMs);
    }

    try {
      const admission = await client.admitSession(token, model);
      return await this.ownedFromAdmission(client, token, model, admission);
    } catch (error) {
      if (!isAmbiguousAdmissionError(error)) throw error;

      let reconciled: FreebuffAdmission;
      try {
        reconciled = await client.getSession(token);
      } catch {
        throw error;
      }

      if (reconciled.status === "active") {
        if (reconciled.model !== model) {
          throw conflictError(
            "Freebuff admission outcome is ambiguous and the active upstream session uses another model"
          );
        }
        return this.buildOwned(client, token, reconciled);
      }

      if (
        reconciled.status === "none" ||
        (reconciled.status === "ended" && !sessionInstanceId(reconciled))
      ) {
        throw error;
      }

      throw freebuffAdmissionError(
        reconciled.status,
        reconciled.retryAfterMs
      );
    }
  }

  private async reconcileExpiredSession(
    record: SessionRecord,
    client: FreebuffSessionClient,
    token: string,
    model: string
  ): Promise<OwnedSession> {
    const previous = record.owned;
    if (!previous) {
      return this.establishSession(client, token, model);
    }

    const current = await client.getSession(token, previous.instanceId);

    if (current.status === "active") {
      if (
        current.instanceId !== previous.instanceId ||
        current.model !== previous.model
      ) {
        throw conflictError(
          "Freebuff session ownership changed during reconciliation"
        );
      }
      return this.buildOwned(client, token, current);
    }

    if (current.status === "none") {
      if (record.owned?.instanceId === previous.instanceId) {
        record.owned = undefined;
      }
      return this.establishSession(client, token, model);
    }

    if (current.status === "ended") {
      if (sessionInstanceId(current)) {
        throw conflictError(
          "Freebuff session expired but is still draining upstream"
        );
      }
      if (record.owned?.instanceId === previous.instanceId) {
        record.owned = undefined;
      }
      return this.establishSession(client, token, model);
    }

    if (record.owned?.instanceId === previous.instanceId) {
      record.owned = undefined;
    }
    throw freebuffAdmissionError(current.status, current.retryAfterMs);
  }

  private async ownedFromAdmission(
    client: FreebuffSessionClient,
    token: string,
    requestedModel: string,
    admission: FreebuffAdmission
  ): Promise<OwnedSession> {
    if (admission.status !== "active") {
      throw freebuffAdmissionError(
        admission.status,
        admission.retryAfterMs
      );
    }

    if (admission.model !== requestedModel) {
      await client
        .releaseSession(token, admission.instanceId)
        .catch(() => {});
      throw conflictError(
        "Freebuff admitted a different model than the one requested"
      );
    }

    return this.buildOwned(client, token, admission);
  }

  private buildOwned(
    client: FreebuffSessionClient,
    token: string,
    admission: Extract<FreebuffAdmission, { status: "active" }>
  ): OwnedSession {
    return {
      instanceId: admission.instanceId,
      model: admission.model,
      expiresAtMs: sessionExpiresAtMs(admission),
      token,
      client,
    };
  }

  private createLease(
    accountKey: string,
    record: SessionRecord,
    owned: OwnedSession
  ): FreebuffSessionLease {
    this.clearIdleTimer(record);
    record.leaseCount += 1;
    let released = false;

    return {
      accountKey,
      instanceId: owned.instanceId,
      model: owned.model,
      release: async () => {
        if (released) return;
        released = true;
        record.leaseCount = Math.max(0, record.leaseCount - 1);
        if (
          record.leaseCount === 0 &&
          !this.closed &&
          this.records.get(accountKey) === record
        ) {
          await this.scheduleIdleRelease(record);
        }
      },
    };
  }

  private async scheduleIdleRelease(record: SessionRecord): Promise<void> {
    this.clearIdleTimer(record);
    if (!record.owned) return;

    if (this.idleReleaseMs <= 0) {
      await this.releaseOwned(record);
      return;
    }

    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (record.leaseCount !== 0) return;
      void this.releaseOwned(record).catch(() => {});
    }, this.idleReleaseMs);
  }

  private clearIdleTimer(record: SessionRecord): void {
    if (!record.idleTimer) return;
    clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
  }

  private async releaseOwned(record: SessionRecord): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    const owned = record.owned;
    if (!owned) return;

    const cleanup = owned.client
      .releaseSession(owned.token, owned.instanceId)
      .then(() => {
        if (record.owned?.instanceId === owned.instanceId) {
          record.owned = undefined;
        }
      })
      .finally(() => {
        if (record.cleanupPromise === cleanup) {
          record.cleanupPromise = undefined;
        }
      });

    record.cleanupPromise = cleanup;
    return cleanup;
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1;

    const cleanups: Promise<void>[] = [];
    for (const record of this.records.values()) {
      this.clearIdleTimer(record);
      if (record.owned) {
        cleanups.push(this.releaseOwned(record).catch(() => {}));
      }
    }

    await Promise.race([
      Promise.allSettled(cleanups).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    this.records.clear();
  }

  resetForTests(): void {
    this.epoch += 1;
    for (const record of this.records.values()) {
      this.clearIdleTimer(record);
    }
    this.records.clear();
    this.closed = false;
  }
}

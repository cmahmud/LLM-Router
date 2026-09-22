import { FreebuffClientError } from "./errors.ts";
import { FreebuffRunManager } from "./runManager.ts";
import { FreebuffSessionManager } from "./sessionManager.ts";

export type FreebuffRequestPermit = {
  signal: AbortSignal;
  release: () => void;
};

export type FreebuffRequestSchedulerOptions = {
  maxGlobal?: number;
  maxPerCredential?: number;
  maxQueued?: number;
  waitTimeoutMs?: number;
};

type ActivePermit = {
  credentialKey: string;
  controller: AbortController;
  release: () => void;
};

type QueueWaiter = {
  id: number;
  credentialKey: string;
  signal?: AbortSignal | null;
  resolve: (permit: FreebuffRequestPermit) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
};

const DEFAULT_MAX_GLOBAL = 2;
const DEFAULT_MAX_PER_CREDENTIAL = 1;
const DEFAULT_MAX_QUEUED = 8;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

function schedulerError(message: string, status = 503): FreebuffClientError {
  return new FreebuffClientError(message, {
    status,
    kind: status === 499 ? "aborted" : "upstream",
  });
}

export class FreebuffRequestScheduler {
  private readonly maxGlobal: number;
  private readonly maxPerCredential: number;
  private readonly maxQueued: number;
  private readonly waitTimeoutMs: number;

  private active = 0;
  private nextId = 1;
  private closed = false;
  private readonly activeByCredential = new Map<string, number>();
  private readonly activePermits = new Map<number, ActivePermit>();
  private readonly queue: QueueWaiter[] = [];

  constructor(options: FreebuffRequestSchedulerOptions = {}) {
    this.maxGlobal = options.maxGlobal ?? DEFAULT_MAX_GLOBAL;
    this.maxPerCredential =
      options.maxPerCredential ?? DEFAULT_MAX_PER_CREDENTIAL;
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  }

  acquire(
    credentialKey: string,
    signal?: AbortSignal | null
  ): Promise<FreebuffRequestPermit> {
    if (this.closed) {
      return Promise.reject(
        schedulerError("Freebuff request scheduler is closed")
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        schedulerError("Freebuff request was aborted", 499)
      );
    }

    if (this.canActivate(credentialKey)) {
      return Promise.resolve(this.activate(credentialKey, signal));
    }

    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(
        schedulerError("Freebuff concurrency queue is full")
      );
    }

    return new Promise<FreebuffRequestPermit>((resolve, reject) => {
      const waiter: QueueWaiter = {
        id: this.nextId++,
        credentialKey,
        signal,
        resolve,
        reject,
      };

      waiter.timer = setTimeout(() => {
        if (!this.removeWaiter(waiter)) return;
        reject(
          new FreebuffClientError(
            "Freebuff concurrency wait timed out",
            { status: 504, kind: "timeout" }
          )
        );
      }, this.waitTimeoutMs);

      if (signal) {
        waiter.abortListener = () => {
          if (!this.removeWaiter(waiter)) return;
          reject(schedulerError("Freebuff queued request was aborted", 499));
        };
        signal.addEventListener("abort", waiter.abortListener, {
          once: true,
        });
      }

      this.queue.push(waiter);
      this.drain();
    });
  }

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  private canActivate(credentialKey: string): boolean {
    return (
      this.active < this.maxGlobal &&
      (this.activeByCredential.get(credentialKey) ?? 0) <
        this.maxPerCredential
    );
  }

  private activate(
    credentialKey: string,
    callerSignal?: AbortSignal | null
  ): FreebuffRequestPermit {
    const id = this.nextId++;
    const controller = new AbortController();
    const effectiveSignal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;

    this.active += 1;
    this.activeByCredential.set(
      credentialKey,
      (this.activeByCredential.get(credentialKey) ?? 0) + 1
    );

    let released = false;
    let callerAbortListener: (() => void) | null = null;

    const release = () => {
      if (released) return;
      released = true;

      if (callerAbortListener && callerSignal) {
        callerSignal.removeEventListener("abort", callerAbortListener);
      }

      this.activePermits.delete(id);
      this.active = Math.max(0, this.active - 1);
      const nextCount =
        (this.activeByCredential.get(credentialKey) ?? 1) - 1;
      if (nextCount <= 0) {
        this.activeByCredential.delete(credentialKey);
      } else {
        this.activeByCredential.set(credentialKey, nextCount);
      }
      this.drain();
    };

    this.activePermits.set(id, {
      credentialKey,
      controller,
      release,
    });

    if (callerSignal) {
      callerAbortListener = () => {
        if (!controller.signal.aborted) {
          controller.abort(
            callerSignal.reason ??
              new DOMException("Freebuff request aborted", "AbortError")
          );
        }
        release();
      };
      callerSignal.addEventListener("abort", callerAbortListener, {
        once: true,
      });
    }

    return { signal: effectiveSignal, release };
  }

  private removeWaiter(waiter: QueueWaiter): boolean {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.clearWaiter(waiter);
    return true;
  }

  private clearWaiter(waiter: QueueWaiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.abortListener && waiter.signal) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
    waiter.timer = undefined;
    waiter.abortListener = undefined;
  }

  private drain(): void {
    if (this.closed) return;

    while (this.active < this.maxGlobal) {
      const index = this.queue.findIndex((waiter) =>
        this.canActivate(waiter.credentialKey)
      );
      if (index < 0) return;

      const [waiter] = this.queue.splice(index, 1);
      this.clearWaiter(waiter);

      if (waiter.signal?.aborted) {
        waiter.reject(
          schedulerError("Freebuff queued request was aborted", 499)
        );
        continue;
      }

      waiter.resolve(
        this.activate(waiter.credentialKey, waiter.signal)
      );
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const queued = this.queue.splice(0);
    for (const waiter of queued) {
      this.clearWaiter(waiter);
      waiter.reject(
        schedulerError("Freebuff request scheduler shut down")
      );
    }

    for (const permit of Array.from(this.activePermits.values())) {
      if (!permit.controller.signal.aborted) {
        permit.controller.abort(
          new DOMException("Freebuff scheduler shutdown", "AbortError")
        );
      }
      permit.release();
    }
  }

  resetForTests(): void {
    const queued = this.queue.splice(0);
    for (const waiter of queued) {
      this.clearWaiter(waiter);
      waiter.reject(
        schedulerError("Freebuff request scheduler reset")
      );
    }
    for (const permit of Array.from(this.activePermits.values())) {
      if (!permit.controller.signal.aborted) {
        permit.controller.abort(
          new DOMException("Freebuff scheduler reset", "AbortError")
        );
      }
      permit.release();
    }
    this.active = 0;
    this.activeByCredential.clear();
    this.activePermits.clear();
    this.closed = false;
  }
}

export type SharedFreebuffRuntime = {
  scheduler: FreebuffRequestScheduler;
  sessions: FreebuffSessionManager;
  runs: FreebuffRunManager;
};

function createSharedRuntime(): SharedFreebuffRuntime {
  return {
    scheduler: new FreebuffRequestScheduler(),
    sessions: new FreebuffSessionManager(),
    runs: new FreebuffRunManager(),
  };
}

let sharedRuntime = createSharedRuntime();

export function getSharedFreebuffRuntime(): SharedFreebuffRuntime {
  return sharedRuntime;
}

export async function shutdownSharedFreebuffRuntime(): Promise<void> {
  const runtime = sharedRuntime;
  await runtime.scheduler.shutdown();
  await runtime.sessions.shutdown();
}

export function resetSharedFreebuffRuntimeForTests(): void {
  sharedRuntime.sessions.resetForTests();
  sharedRuntime.scheduler.resetForTests();
  sharedRuntime = createSharedRuntime();
}

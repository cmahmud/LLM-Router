import assert from "node:assert/strict";
import test from "node:test";

import { FreebuffClientError } from "../../open-sse/executors/freebuff/errors.ts";
import {
  FreebuffSessionManager,
  freebuffCredentialKey,
} from "../../open-sse/executors/freebuff/sessionManager.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("Freebuff session manager: duplicate tokens share one single-flight admission", async () => {
  let getCalls = 0;
  let admitCalls = 0;
  const admission = deferred<{
    status: "active";
    instanceId: string;
    model: string;
  }>();

  const client = {
    async getSession() {
      getCalls += 1;
      return { status: "none" as const };
    },
    async admitSession() {
      admitCalls += 1;
      return admission.promise;
    },
    async releaseSession() {},
  };

  const manager = new FreebuffSessionManager({ idleReleaseMs: 60_000 });
  const token = "fixture-shared-token";
  const model = "deepseek/deepseek-v4-flash";
  const leases = Array.from({ length: 20 }, () => manager.acquire({ client, token, model }));

  await Promise.resolve();
  assert.equal(getCalls, 1);
  assert.equal(admitCalls, 1);

  admission.resolve({
    status: "active",
    instanceId: "fixture-instance-001",
    model,
  });

  const resolved = await Promise.all(leases);
  assert.equal(new Set(resolved.map((lease) => lease.instanceId)).size, 1);
  assert.equal(getCalls, 1);
  assert.equal(admitCalls, 1);

  await Promise.all(resolved.map((lease) => lease.release()));
  await manager.shutdown();
});

test("Freebuff session manager: leader abort does not cancel shared admission for followers", async () => {
  const admission = deferred<{
    status: "active";
    instanceId: string;
    model: string;
  }>();
  let admitCalls = 0;

  const client = {
    async getSession() {
      return { status: "none" as const };
    },
    async admitSession() {
      admitCalls += 1;
      return admission.promise;
    },
    async releaseSession() {},
  };

  const manager = new FreebuffSessionManager();
  const leaderAbort = new AbortController();
  const token = "fixture-shared-token";
  const model = "deepseek/deepseek-v4-flash";

  const leader = manager.acquire({
    client,
    token,
    model,
    signal: leaderAbort.signal,
  });
  const follower = manager.acquire({ client, token, model });

  await Promise.resolve();
  leaderAbort.abort(new DOMException("fixture abort", "AbortError"));
  await assert.rejects(leader, /aborted/i);

  admission.resolve({
    status: "active",
    instanceId: "fixture-instance-002",
    model,
  });

  const followerLease = await follower;
  assert.equal(followerLease.instanceId, "fixture-instance-002");
  assert.equal(admitCalls, 1);

  await followerLease.release();
  await manager.shutdown();
});

test("Freebuff session manager: ambiguous admission failure reconciles once without re-POST", async () => {
  let getCalls = 0;
  let admitCalls = 0;
  const model = "deepseek/deepseek-v4-flash";

  const client = {
    async getSession() {
      getCalls += 1;
      if (getCalls === 1) return { status: "none" as const };
      return {
        status: "active" as const,
        instanceId: "fixture-reconciled-instance",
        model,
      };
    },
    async admitSession() {
      admitCalls += 1;
      throw new FreebuffClientError("fixture network failure", {
        status: 502,
        kind: "network",
      });
    },
    async releaseSession() {},
  };

  const manager = new FreebuffSessionManager();
  const lease = await manager.acquire({
    client,
    token: "fixture-reconcile-token",
    model,
  });

  assert.equal(lease.instanceId, "fixture-reconciled-instance");
  assert.equal(getCalls, 2);
  assert.equal(admitCalls, 1);

  await lease.release();
  await manager.shutdown();
});

test("Freebuff session manager: existing unowned active session is never taken over", async () => {
  let admitCalls = 0;
  let deleteCalls = 0;
  const model = "deepseek/deepseek-v4-flash";

  const client = {
    async getSession() {
      return {
        status: "active" as const,
        instanceId: "fixture-foreign-instance",
        model,
      };
    },
    async admitSession() {
      admitCalls += 1;
      return {
        status: "active" as const,
        instanceId: "must-not-happen",
        model,
      };
    },
    async releaseSession() {
      deleteCalls += 1;
    },
  };

  const manager = new FreebuffSessionManager();
  await assert.rejects(
    manager.acquire({
      client,
      token: "fixture-foreign-token",
      model,
    }),
    /already active|unowned|take over/i
  );

  assert.equal(admitCalls, 0);
  assert.equal(deleteCalls, 0);
  await manager.shutdown();
});

test("Freebuff session manager: model switch is refused while an owned session is leased", async () => {
  let admitCalls = 0;
  const client = {
    async getSession() {
      return { status: "none" as const };
    },
    async admitSession(_token: string, model: string) {
      admitCalls += 1;
      return {
        status: "active" as const,
        instanceId: "fixture-owned-instance",
        model,
      };
    },
    async releaseSession() {},
  };

  const manager = new FreebuffSessionManager();
  const lease = await manager.acquire({
    client,
    token: "fixture-model-lock-token",
    model: "deepseek/deepseek-v4-flash",
  });

  await assert.rejects(
    manager.acquire({
      client,
      token: "fixture-model-lock-token",
      model: "deepseek/deepseek-v4-pro",
    }),
    /model|switch|leased/i
  );
  assert.equal(admitCalls, 1);

  await lease.release();
  await manager.shutdown();
});

test("Freebuff session manager: credential keys share duplicate tokens but not refreshed generations", () => {
  assert.equal(freebuffCredentialKey("same-token"), freebuffCredentialKey("same-token"));
  assert.notEqual(freebuffCredentialKey("old-token"), freebuffCredentialKey("new-token"));
  assert.doesNotMatch(freebuffCredentialKey("same-token"), /same-token/);
});

test("Freebuff session manager: idle release deletes only the owned instance", async () => {
  const deletes: string[] = [];
  const model = "deepseek/deepseek-v4-flash";

  const client = {
    async getSession() {
      return { status: "none" as const };
    },
    async admitSession() {
      return {
        status: "active" as const,
        instanceId: "fixture-owned-delete",
        model,
      };
    },
    async releaseSession(_token: string, instanceId: string) {
      deletes.push(instanceId);
    },
  };

  const manager = new FreebuffSessionManager({ idleReleaseMs: 0 });
  const lease = await manager.acquire({
    client,
    token: "fixture-owned-delete-token",
    model,
  });

  // A zero idle timeout must not release a freshly admitted session before
  // the successful waiter has converted the transition result into a lease.
  assert.deepEqual(deletes, []);
  await lease.release();

  assert.deepEqual(deletes, ["fixture-owned-delete"]);
  await manager.shutdown();
});

test("Freebuff session manager: leader-only abort still idles out an admission that later succeeds", async () => {
  const admission = deferred<{
    status: "active";
    instanceId: string;
    model: string;
  }>();
  const deletes: string[] = [];
  const model = "deepseek/deepseek-v4-flash";

  const client = {
    async getSession() {
      return { status: "none" as const };
    },
    async admitSession() {
      return admission.promise;
    },
    async releaseSession(_token: string, instanceId: string) {
      deletes.push(instanceId);
    },
  };

  const manager = new FreebuffSessionManager({ idleReleaseMs: 0 });
  const controller = new AbortController();
  const leader = manager.acquire({
    client,
    token: "fixture-abandoned-admission-token",
    model,
    signal: controller.signal,
  });

  await Promise.resolve();
  controller.abort(new DOMException("fixture leader cancel", "AbortError"));
  await assert.rejects(leader, /aborted/i);

  admission.resolve({
    status: "active",
    instanceId: "fixture-abandoned-instance",
    model,
  });
  // The zero-idle cleanup is scheduled after the abandoned shared admission
  // settles; allow that timer and its microtask to run before observing it.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(deletes, ["fixture-abandoned-instance"]);
  await manager.shutdown();
});

test("Freebuff session manager: acquire waits for idle cleanup before reusing a credential", async () => {
  const cleanupStarted = deferred<void>();
  const cleanup = deferred<void>();
  const model = "deepseek/deepseek-v4-flash";
  let admitCalls = 0;
  let deleteCalls = 0;

  const client = {
    async getSession() {
      return { status: "none" as const };
    },
    async admitSession() {
      admitCalls += 1;
      return {
        status: "active" as const,
        instanceId: `fixture-cleanup-race-${admitCalls}`,
        model,
      };
    },
    async releaseSession() {
      deleteCalls += 1;
      if (deleteCalls === 1) {
        cleanupStarted.resolve(undefined);
        await cleanup.promise;
      }
    },
  };

  const manager = new FreebuffSessionManager({ idleReleaseMs: 1 });
  const first = await manager.acquire({
    client,
    token: "fixture-cleanup-race-token",
    model,
  });
  assert.equal(first.instanceId, "fixture-cleanup-race-1");
  await first.release();

  await cleanupStarted.promise;

  let secondResolved = false;
  const secondPromise = manager
    .acquire({
      client,
      token: "fixture-cleanup-race-token",
      model,
    })
    .then((lease) => {
      secondResolved = true;
      return lease;
    });

  await Promise.resolve();
  assert.equal(secondResolved, false);
  assert.equal(admitCalls, 1);

  cleanup.resolve(undefined);
  const second = await secondPromise;

  assert.equal(second.instanceId, "fixture-cleanup-race-2");
  assert.equal(admitCalls, 2);

  await second.release();
  await manager.shutdown();
});

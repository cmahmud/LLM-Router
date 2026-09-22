import assert from "node:assert/strict";
import test from "node:test";

import { FreebuffRequestScheduler } from "../../open-sse/executors/freebuff/runtime.ts";

test("Freebuff request scheduler: enforces two global and one per credential", async () => {
  const scheduler = new FreebuffRequestScheduler({
    maxGlobal: 2,
    maxPerCredential: 1,
    maxQueued: 8,
    waitTimeoutMs: 5_000,
  });

  const a1 = await scheduler.acquire("account-a");
  const b1 = await scheduler.acquire("account-b");
  let cResolved = false;
  const cPromise = scheduler.acquire("account-c").then((permit) => {
    cResolved = true;
    return permit;
  });

  await Promise.resolve();
  assert.equal(cResolved, false);
  assert.deepEqual(scheduler.stats(), { active: 2, queued: 1 });

  a1.release();
  const c1 = await cPromise;
  assert.equal(cResolved, true);
  assert.deepEqual(scheduler.stats(), { active: 2, queued: 0 });

  b1.release();
  c1.release();
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 0 });
  await scheduler.shutdown();
});

test("Freebuff request scheduler: FIFO is preserved within one credential", async () => {
  const scheduler = new FreebuffRequestScheduler({
    maxGlobal: 2,
    maxPerCredential: 1,
    maxQueued: 8,
    waitTimeoutMs: 5_000,
  });

  const first = await scheduler.acquire("same-account");
  const order: number[] = [];
  const secondP = scheduler.acquire("same-account").then((permit) => {
    order.push(2);
    return permit;
  });
  const thirdP = scheduler.acquire("same-account").then((permit) => {
    order.push(3);
    return permit;
  });

  first.release();
  const second = await secondP;
  assert.deepEqual(order, [2]);

  second.release();
  const third = await thirdP;
  assert.deepEqual(order, [2, 3]);

  third.release();
  await scheduler.shutdown();
});

test("Freebuff request scheduler: queue is bounded at eight waiters", async () => {
  const scheduler = new FreebuffRequestScheduler({
    maxGlobal: 2,
    maxPerCredential: 1,
    maxQueued: 8,
    waitTimeoutMs: 5_000,
  });

  const activeA = await scheduler.acquire("active-a");
  const activeB = await scheduler.acquire("active-b");
  const queued = Array.from({ length: 8 }, (_, index) =>
    scheduler.acquire(`queued-${index}`).then((permit) => {
      permit.release();
    })
  );

  await assert.rejects(
    scheduler.acquire("overflow"),
    /queue.*full|capacity/i
  );
  assert.equal(scheduler.stats().queued, 8);

  activeA.release();
  activeB.release();
  await Promise.all(queued);
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 0 });
  await scheduler.shutdown();
});

test("Freebuff request scheduler: aborting a queued waiter removes it without disturbing followers", async () => {
  const scheduler = new FreebuffRequestScheduler({
    maxGlobal: 1,
    maxPerCredential: 1,
    maxQueued: 8,
    waitTimeoutMs: 5_000,
  });

  const active = await scheduler.acquire("active");
  const controller = new AbortController();
  const cancelled = scheduler.acquire("cancel-me", controller.signal);
  const follower = scheduler.acquire("follower");

  controller.abort(
    new DOMException("fixture cancel", "AbortError")
  );
  await assert.rejects(cancelled, /aborted|cancel/i);
  assert.equal(scheduler.stats().queued, 1);

  active.release();
  const next = await follower;
  next.release();
  await scheduler.shutdown();
});

test("Freebuff request scheduler: shutdown aborts active permits and rejects all queued waiters", async () => {
  const scheduler = new FreebuffRequestScheduler({
    maxGlobal: 1,
    maxPerCredential: 1,
    maxQueued: 8,
    waitTimeoutMs: 5_000,
  });

  const active = await scheduler.acquire("active");
  const queuedOutcome = scheduler
    .acquire("queued")
    .then(
      () => null,
      (error) => error
    );

  await scheduler.shutdown();
  assert.equal(active.signal.aborted, true);
  const queuedError = await queuedOutcome;
  assert.ok(queuedError instanceof Error);
  assert.match(queuedError.message, /shut|closed|aborted/i);
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 0 });
});

test("Freebuff request scheduler: queued waits are bounded", async () => {
  const scheduler = new FreebuffRequestScheduler({
    maxGlobal: 1,
    maxPerCredential: 1,
    maxQueued: 8,
    waitTimeoutMs: 15,
  });

  const active = await scheduler.acquire("active");
  await assert.rejects(
    scheduler.acquire("times-out"),
    /timed out|timeout/i
  );
  active.release();
  await scheduler.shutdown();
});

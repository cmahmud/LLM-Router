import assert from "node:assert/strict";
import test from "node:test";

import { FreebuffRunManager } from "../../open-sse/executors/freebuff/runManager.ts";

test("Freebuff run manager: each request gets its own run and finalize is exactly once", async () => {
  let startCounter = 0;
  const finishes: Array<{ runId: string; status: string }> = [];

  const client = {
    async startRun() {
      startCounter += 1;
      return { runId: `fixture-run-${startCounter}` };
    },
    async finishRun(input: { runId: string; status: string }) {
      finishes.push({ runId: input.runId, status: input.status });
    },
  };

  const manager = new FreebuffRunManager();
  const first = await manager.start({
    client,
    token: "fixture-token",
    agentId: "fixture-agent",
  });
  const second = await manager.start({
    client,
    token: "fixture-token",
    agentId: "fixture-agent",
  });

  assert.notEqual(first.runId, second.runId);
  await Promise.all([
    first.finalize("completed"),
    first.finalize("failed"),
    first.finalize("cancelled"),
    second.finalize("failed"),
  ]);

  assert.deepEqual(finishes, [
    { runId: "fixture-run-1", status: "completed" },
    { runId: "fixture-run-2", status: "failed" },
  ]);
});

test("Freebuff run manager: cancellation is never rewritten as success", async () => {
  const statuses: string[] = [];
  const client = {
    async startRun() {
      return { runId: "fixture-run-cancel" };
    },
    async finishRun(input: { status: string }) {
      statuses.push(input.status);
    },
  };

  const handle = await new FreebuffRunManager().start({
    client,
    token: "fixture-token",
    agentId: "fixture-agent",
  });

  await handle.finalize("cancelled");
  await handle.finalize("completed");
  assert.deepEqual(statuses, ["cancelled"]);
});

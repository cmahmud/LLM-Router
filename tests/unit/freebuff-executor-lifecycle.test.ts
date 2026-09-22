import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { FreebuffExecutor } from "../../open-sse/executors/freebuff.ts";
import {
  getSharedFreebuffRuntime,
  resetSharedFreebuffRuntimeForTests,
} from "../../open-sse/executors/freebuff/runtime.ts";
import {
  __resetFreebuffHealthForTests,
  getFreebuffHealthSnapshot,
} from "../../open-sse/executors/freebuff/health.ts";
import { getFreebuffCatalogSnapshot } from "../../open-sse/executors/freebuff/catalog.ts";
import {
  createFreebuffFetchMock,
  deferredFreebuffResponse,
  freebuffFixtureResponse,
  readFreebuffFixtureJson,
  withFreebuffFetch,
} from "./helpers/freebuff-fixtures.ts";

afterEach(() => {
  resetSharedFreebuffRuntimeForTests();
  __resetFreebuffHealthForTests();
});

const CREDENTIALS = { apiKey: "fixture-token-only-in-memory" };
const BASE_INPUT = {
  model: "deepseek/deepseek-v4-flash",
  body: { messages: [{ role: "user", content: "fixture prompt" }] },
  stream: true,
  credentials: CREDENTIALS,
};

function callFor(calls: Array<{ url: string; bodyJson: unknown }>, suffix: string) {
  return calls.find((call) => call.url.endsWith(suffix));
}

test("Freebuff P0 fixture set contains representative synthetic protocol shapes", () => {
  const shapes = readFreebuffFixtureJson<{
    _fixture: string;
    sourceRevision: string;
    admission: { active: object; rateLimited: object; legacyMalformed: object };
    run: { start: object; finish: object };
    chat: { stream: string; terminal: string };
  }>("protocol-shapes.json");

  assert.equal(shapes._fixture, "synthetic");
  assert.match(shapes.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(shapes.admission.active.status, "active");
  assert.equal(shapes.admission.rateLimited.status, "rate_limited");
  assert.equal(shapes.admission.legacyMalformed.state, "queued");
  assert.equal(shapes.run.start.action, "START");
  assert.equal(shapes.run.finish.action, "FINISH");
  assert.equal(shapes.chat.terminal, "[DONE]");
});

test("Freebuff P0 regression: legacy queued-shaped admission must fail closed", async () => {
  const { fetch: fetchMock, calls } = createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      response: freebuffFixtureResponse("session-admission-queued.json"),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );

  assert.ok(
    result.response.status >= 400,
    "legacy queued-shaped admission must be surfaced as an error"
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/api/v1/agent-runs")).length,
    0,
    "legacy queued-shaped admission must not start a run"
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/api/v1/chat/completions")).length,
    0,
    "legacy queued-shaped admission must not dispatch chat"
  );
});

test("Freebuff P0 regression: missing active instance must stop before START", async () => {
  const { fetch: fetchMock, calls } = createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      response: freebuffFixtureResponse("session-admission-active-missing-instance.json"),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );

  assert.ok(result.response.status >= 400, "missing instance must be an upstream error");
  assert.equal(calls.filter((call) => call.url.endsWith("/api/v1/agent-runs")).length, 0);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/v1/chat/completions")).length, 0);
});

test("Freebuff P0 regression: START failure must stop before chat dispatch", async () => {
  const { fetch: fetchMock, calls } = createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      response: freebuffFixtureResponse("session-admission-active.json"),
    },
    {
      match: (call) =>
        call.url.endsWith("/api/v1/agent-runs") &&
        (call.bodyJson as { action?: string })?.action === "START",
      response: freebuffFixtureResponse("run-start-failure.json", {
        status: 503,
      }),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );

  assert.ok(result.response.status >= 400, "START failure must be surfaced");
  assert.equal(calls.filter((call) => call.url.endsWith("/api/v1/chat/completions")).length, 0);
});

test("Freebuff P0 regression: server-owned metadata cannot be overridden by caller", async () => {
  const body = {
    ...BASE_INPUT.body,
    codebuff_metadata: {
      run_id: "caller-run-override",
      client_id: "caller-client-override",
      freebuff_instance_id: "caller-instance-override",
      totalCredits: 999,
    },
  };
  const { fetch: fetchMock, calls } = createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      response: freebuffFixtureResponse("session-admission-active.json"),
    },
    {
      match: (call) =>
        call.url.endsWith("/api/v1/agent-runs") &&
        (call.bodyJson as { action?: string })?.action === "START",
      response: freebuffFixtureResponse("run-start-success.json"),
    },
    {
      match: /api\/v1\/chat\/completions/,
      response: freebuffFixtureResponse("chat-response.json"),
    },
  ]);

  const execution = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute({ ...BASE_INPUT, body, stream: false } as never)
  );

  const chat = callFor(calls, "/api/v1/chat/completions");
  assert.ok(chat, "chat request must be observed");
  const metadata = (chat?.bodyJson as { codebuff_metadata?: Record<string, unknown> })
    ?.codebuff_metadata;
  assert.equal(metadata?.run_id, "fixture-run-001");
  assert.equal(metadata?.freebuff_instance_id, "fixture-instance-001");
  assert.notEqual(metadata?.client_id, "caller-client-override");
  assert.notEqual(metadata?.totalCredits, 999);
  await execution.response.arrayBuffer();
});

test("Freebuff P0 regression: FINISH waits for body consumption", async () => {
  const deferred = deferredFreebuffResponse();
  const { fetch: fetchMock, calls } = createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      response: freebuffFixtureResponse("session-admission-active.json"),
    },
    {
      match: (call) =>
        call.url.endsWith("/api/v1/agent-runs") &&
        (call.bodyJson as { action?: string })?.action === "START",
      response: freebuffFixtureResponse("run-start-success.json"),
    },
    {
      match: /api\/v1\/chat\/completions/,
      response: deferred.response,
    },
    {
      match: (call) =>
        call.url.endsWith("/api/v1/agent-runs") &&
        (call.bodyJson as { action?: string })?.action === "FINISH",
      response: new Response(null, { status: 204 }),
    },
  ]);

  const execution = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );

  assert.equal(
    calls.filter(
      (call) =>
        call.url.endsWith("/api/v1/agent-runs") &&
        (call.bodyJson as { action?: string })?.action === "FINISH"
    ).length,
    0,
    "FINISH must not be sent before response body consumption"
  );

  deferred.release();
  await execution.response.arrayBuffer();

  assert.equal(
    calls.filter(
      (call) =>
        call.url.endsWith("/api/v1/agent-runs") &&
        (call.bodyJson as { action?: string })?.action === "FINISH"
    ).length,
    1,
    "FINISH must be sent exactly once after body consumption"
  );
});

test("Freebuff P0 regression: missing admission errors are sanitized", async () => {
  const upstreamBody = readFreebuffFixtureJson<{ error: { message: string } }>(
    "upstream-error.json"
  );
  const { fetch: fetchMock } = createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      response: new Response(JSON.stringify(upstreamBody), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );
  const responseBody = (await result.response.json()) as { error?: { message?: string } };

  assert.equal(result.response.status, 502);
  assert.doesNotMatch(responseBody.error?.message || "", /synthetic upstream diagnostic/);
});

function healthSnapshot() {
  return getFreebuffHealthSnapshot({
    configured: true,
    runtime: getSharedFreebuffRuntime(),
    catalog: getFreebuffCatalogSnapshot(),
  });
}

function createLifecycleFetchMock(chatResponse: Response) {
  return createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      response: freebuffFixtureResponse("session-admission-active.json"),
    },
    {
      match: (call) =>
        call.url.endsWith("/api/v1/agent-runs") &&
        (call.bodyJson as { action?: string })?.action === "START",
      response: freebuffFixtureResponse("run-start-success.json"),
    },
    {
      match: /api\/v1\/chat\/completions/,
      response: chatResponse,
    },
  ]);
}

test("Freebuff P5 health records success only at terminal response settlement", async () => {
  const deferred = deferredFreebuffResponse();
  const { fetch: fetchMock } = createLifecycleFetchMock(deferred.response);

  const execution = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );

  assert.equal(healthSnapshot().requests.total, 0);
  deferred.release();
  await execution.response.arrayBuffer();

  const settled = healthSnapshot();
  assert.equal(settled.requests.total, 1);
  assert.equal(settled.requests.failed, 0);
});

test("Freebuff P5 health classifies a missing stream terminal as malformed", async () => {
  const deferred = deferredFreebuffResponse([
    'data: {"id":"partial","choices":[{"delta":{"content":"partial"}}]}\n\n',
  ]);
  const { fetch: fetchMock } = createLifecycleFetchMock(deferred.response);

  const execution = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );
  deferred.release();
  await assert.rejects(execution.response.arrayBuffer(), /terminal event/);

  const settled = healthSnapshot();
  assert.equal(settled.requests.total, 1);
  assert.equal(settled.requests.failed, 1);
  assert.equal(settled.requests.errorsByPhase.chat, 1);
  assert.equal(settled.requests.errorsByKind.malformed, 1);
});

test("Freebuff P5 health records downstream cancellation exactly once", async () => {
  const deferred = deferredFreebuffResponse();
  const { fetch: fetchMock } = createLifecycleFetchMock(deferred.response);

  const execution = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );
  const reader = execution.response.body?.getReader();
  assert.ok(reader);
  await reader.cancel(new DOMException("test cancellation", "AbortError"));

  const settled = healthSnapshot();
  assert.equal(settled.requests.total, 1);
  assert.equal(settled.requests.failed, 1);
  assert.equal(settled.requests.errorsByPhase.chat, 1);
  assert.equal(settled.requests.errorsByKind.aborted, 1);
});

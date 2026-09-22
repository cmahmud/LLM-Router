import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { FreebuffExecutor } from "../../open-sse/executors/freebuff.ts";
import { resetSharedFreebuffRuntimeForTests } from "../../open-sse/executors/freebuff/runtime.ts";
import {
  createFreebuffFetchMock,
  freebuffFixtureResponse,
  withFreebuffFetch,
} from "./helpers/freebuff-fixtures.ts";

afterEach(() => resetSharedFreebuffRuntimeForTests());

const BASE_INPUT = {
  model: "deepseek/deepseek-v4-flash",
  body: { messages: [{ role: "user", content: "hello" }] },
  stream: false,
  credentials: { apiKey: "fixture-token" },
};

function headersFor(call: { init: RequestInit }): Headers {
  return new Headers(call.init.headers);
}

test("Freebuff transport: whitespace-only credentials fail before any network request", async () => {
  let called = false;
  const fetchMock: typeof globalThis.fetch = async () => {
    called = true;
    throw new Error("must not run");
  };

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute({
      ...BASE_INPUT,
      credentials: { apiKey: "   " },
    } as never)
  );

  assert.equal(result.response.status, 401);
  assert.equal(called, false);
});

test("Freebuff transport: uses dedicated admission endpoint and protocol headers without spoofed UA", async () => {
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
      match: /api\/v1\/chat\/completions$/,
      response: freebuffFixtureResponse("chat-response.json"),
    },
    {
      match: (call) =>
        call.url.endsWith("/api/v1/agent-runs") &&
        (call.bodyJson as { action?: string })?.action === "FINISH",
      response: new Response(null, { status: 204 }),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );
  assert.equal(result.response.status, 200);
  await result.response.arrayBuffer();

  const admission = calls.find((call) => call.url.endsWith("/freebuff/session/admission"));
  assert.ok(admission);
  assert.equal(admission?.init.method, "POST");
  assert.equal(admission?.bodyText, "");
  assert.equal(headersFor(admission!).get("x-freebuff-model"), "deepseek/deepseek-v4-flash");
  assert.equal(headersFor(admission!).get("x-freebuff-wallet-spend-limit"), "0");

  const finish = calls.find(
    (call) =>
      call.url.endsWith("/api/v1/agent-runs") &&
      (call.bodyJson as { action?: string })?.action === "FINISH"
  );
  assert.ok(finish);
  const finishBody = finish?.bodyJson as Record<string, unknown>;
  assert.equal("totalSteps" in finishBody, false, "FINISH must not fabricate usage");
  assert.equal("directCredits" in finishBody, false, "FINISH must not fabricate credits");
  assert.equal("totalCredits" in finishBody, false, "FINISH must not fabricate credits");

  for (const call of calls) {
    assert.equal(
      headersFor(call).has("user-agent"),
      false,
      `must not spoof a first-party user agent for ${call.url}`
    );
  }
});

test("Freebuff transport: preserves safe payload metadata and client content while server IDs win", async () => {
  const messages = [
    { role: "system", content: "Keep this caller-supplied system instruction unchanged." },
    { role: "user", content: "Use the tool if needed." },
  ];
  const tools = [
    {
      type: "function",
      function: {
        name: "fixture_tool",
        description: "fixture",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  const body = {
    messages,
    tools,
    codebuff_metadata: {
      trace_label: "keep-me",
      run_id: "caller-run",
      client_id: "caller-client",
      freebuff_instance_id: "caller-instance",
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
      match: /api\/v1\/chat\/completions$/,
      response: freebuffFixtureResponse("chat-response.json"),
    },
  ]);

  const execution = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute({ ...BASE_INPUT, body } as never)
  );

  const chat = calls.find((call) => call.url.endsWith("/api/v1/chat/completions"));
  assert.ok(chat);
  const sent = chat?.bodyJson as {
    messages: unknown;
    tools: unknown;
    codebuff_metadata: Record<string, unknown>;
  };
  assert.deepEqual(sent.messages, messages);
  assert.deepEqual(sent.tools, tools);
  assert.equal(sent.codebuff_metadata.trace_label, "keep-me");
  assert.equal(sent.codebuff_metadata.run_id, "fixture-run-001");
  assert.equal(sent.codebuff_metadata.freebuff_instance_id, "fixture-instance-001");
  assert.notEqual(sent.codebuff_metadata.client_id, "caller-client");
  assert.equal("totalCredits" in sent.codebuff_metadata, false);
  await execution.response.arrayBuffer();
});

test("Freebuff transport: malformed START success is a structured error and chat is not dispatched", async () => {
  const { fetch: fetchMock, calls } = createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      response: freebuffFixtureResponse("session-admission-active.json"),
    },
    {
      match: /api\/v1\/agent-runs$/,
      response: new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );
  assert.equal(result.response.status, 502);
  const payload = (await result.response.json()) as { error?: { type?: string; code?: string } };
  assert.equal(payload.error?.type, "upstream_error");
  assert.equal(
    calls.some((call) => call.url.endsWith("/api/v1/chat/completions")),
    false
  );
});

test("Freebuff transport: session network failures are sanitized", async () => {
  const { fetch: fetchMock } = createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      error: new Error("ECONNRESET synthetic-token-secret"),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );
  assert.equal(result.response.status, 502);
  const text = await result.response.text();
  assert.match(text, /network request failed/i);
  assert.doesNotMatch(text, /synthetic-token-secret|ECONNRESET/);
});

test("Freebuff transport: caller abort is propagated and classified separately from network failure", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("fixture caller abort", "AbortError"));

  const fetchMock: typeof globalThis.fetch = async (_input, init) => {
    if (init?.signal?.aborted) {
      throw init.signal.reason;
    }
    throw new Error("signal should already be aborted");
  };

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute({
      ...BASE_INPUT,
      signal: controller.signal,
    } as never)
  );

  assert.equal(result.response.status, 499);
  const payload = (await result.response.json()) as { error?: { code?: string } };
  assert.equal(payload.error?.code, "aborted");
});

test("Freebuff transport: typed admission rate limits preserve Retry-After", async () => {
  const { fetch: fetchMock, calls } = createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      response: new Response(
        JSON.stringify({
          status: "rate_limited",
          model: "deepseek/deepseek-v4-flash",
          retryAfterMs: 2500,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "2",
          },
        }
      ),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );

  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers.get("retry-after"), "3");
  assert.equal(
    calls.some((call) => call.url.endsWith("/api/v1/agent-runs")),
    false
  );
});

test("Freebuff transport: malformed admission JSON fails closed before START", async () => {
  const { fetch: fetchMock, calls } = createFreebuffFetchMock([
    {
      match: /freebuff\/session\/admission$/,
      response: new Response("{not-json", {
        headers: { "Content-Type": "application/json" },
      }),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    new FreebuffExecutor().execute(BASE_INPUT as never)
  );

  assert.equal(result.response.status, 502);
  assert.equal(
    calls.some((call) => call.url.endsWith("/api/v1/agent-runs")),
    false
  );
});

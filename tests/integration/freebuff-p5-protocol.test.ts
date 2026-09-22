import assert from "node:assert/strict";
import test from "node:test";

import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";
import {
  __resetFreebuffHealthForTests,
  getFreebuffHealthSnapshot,
} from "../../open-sse/executors/freebuff/health.ts";
import { getFreebuffCatalogSnapshot } from "../../open-sse/executors/freebuff/catalog.ts";
import {
  getSharedFreebuffRuntime,
  resetSharedFreebuffRuntimeForTests,
} from "../../open-sse/executors/freebuff/runtime.ts";

const harness = await createChatPipelineHarness("freebuff-p5-protocol");
const { buildRequest, cleanup, resetStorage, seedConnection } = harness;
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
const responsesRoute = await import("../../src/app/api/v1/responses/route.ts");
const messagesRoute = await import("../../src/app/api/v1/messages/route.ts");

type MockCall = {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
};

type ProtocolContentBlock = { type?: string; text?: string; id?: string };

type ProtocolPayload = {
  object?: string;
  type?: string;
  role?: string;
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
    };
  }>;
  output?: Array<{
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<ProtocolContentBlock>;
  }>;
  content?: Array<ProtocolContentBlock>;
};

type FreebuffMock = {
  calls: MockCall[];
  chatBodies: Array<Record<string, unknown>>;
  install: () => void;
};

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function chatResponse(content: string): Response {
  return jsonResponse({
    id: "chatcmpl_p5_fixture",
    object: "chat.completion",
    model: "deepseek/deepseek-v4-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });
}

function toolCallResponse(): Response {
  return jsonResponse({
    id: "chatcmpl_p5_tool",
    object: "chat.completion",
    model: "deepseek/deepseek-v4-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_p5_weather",
              type: "function",
              function: {
                name: "lookup_weather",
                arguments: JSON.stringify({ city: "Dhaka" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
  });
}

function multiToolCallResponse(): Response {
  return jsonResponse({
    id: "chatcmpl_p5_multi_tool",
    object: "chat.completion",
    model: "deepseek/deepseek-v4-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_p5_weather",
              type: "function",
              function: {
                name: "lookup_weather",
                arguments: JSON.stringify({ city: "Dhaka" }),
              },
            },
            {
              id: "call_p5_time",
              type: "function",
              function: {
                name: "lookup_time",
                arguments: JSON.stringify({ city: "Dhaka" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
  });
}

function anthropicInputResponse(): Response {
  return chatResponse("anthropic-compatible");
}

function chatStreamResponse(): Response {
  const chunks = [
    {
      id: "chatcmpl_p5_stream",
      object: "chat.completion.chunk",
      model: "deepseek/deepseek-v4-flash",
      choices: [{ index: 0, delta: { role: "assistant", content: "stream" }, finish_reason: null }],
    },
    {
      id: "chatcmpl_p5_stream",
      object: "chat.completion.chunk",
      model: "deepseek/deepseek-v4-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function createFreebuffMock(
  chatFactory: (body: Record<string, unknown>, index: number) => Response = () => chatResponse("ok")
): FreebuffMock {
  const calls: MockCall[] = [];
  const chatBodies: Array<Record<string, unknown>> = [];
  let chatIndex = 0;
  let runIndex = 0;

  const install = () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (
        input instanceof Request ? input.method : (init.method ?? "GET")
      ).toUpperCase();
      const headers = new Headers(input instanceof Request ? input.headers : init.headers);
      let bodyText = typeof init.body === "string" ? init.body : "";
      if (input instanceof Request && !bodyText) bodyText = await input.text();
      let body: Record<string, unknown> | null = null;
      if (bodyText) {
        try {
          const parsed = JSON.parse(bodyText);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
          }
        } catch {
          body = null;
        }
      }
      calls.push({ url, method, headers, body });

      if (url.endsWith("/api/v1/freebuff/session") && method === "GET") {
        return jsonResponse({ status: "none" });
      }
      if (url.endsWith("/api/v1/freebuff/session/admission") && method === "POST") {
        return jsonResponse({
          status: "active",
          instanceId: "p5-instance",
          model: headers.get("x-freebuff-model") ?? "deepseek/deepseek-v4-flash",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      if (url.endsWith("/api/v1/agent-runs") && method === "POST") {
        if (body?.action === "START") {
          runIndex += 1;
          return jsonResponse({ runId: `p5-run-${runIndex}`, status: "started" });
        }
        if (body?.action === "FINISH") return new Response(null, { status: 204 });
      }
      if (url.endsWith("/api/v1/chat/completions") && method === "POST") {
        const chatBody = body ?? {};
        chatBodies.push(chatBody);
        return chatFactory(chatBody, chatIndex++);
      }
      if (url.endsWith("/api/v1/freebuff/session") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected synthetic Freebuff request: ${method} ${url}`);
    }) as typeof globalThis.fetch;
  };

  return { calls, chatBodies, install };
}

function modelBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "fb/deepseek/deepseek-v4-flash",
    stream: false,
    messages: [{ role: "user", content: "hello from P5" }],
    ...overrides,
  };
}

test.beforeEach(async () => {
  await resetStorage();
  resetSharedFreebuffRuntimeForTests();
  __resetFreebuffHealthForTests();
  await seedConnection("freebuff", { apiKey: "p5-fixture-token" });
});

test.afterEach(() => {
  resetSharedFreebuffRuntimeForTests();
  __resetFreebuffHealthForTests();
});

test.after(async () => {
  await cleanup();
});

test("P5 Chat Completions route reaches Freebuff with normalized model and returns OpenAI JSON", async () => {
  const mock = createFreebuffMock();
  mock.install();

  const response = await chatRoute.POST(
    buildRequest({ body: modelBody({ messages: [{ role: "user", content: "chat protocol" }] }) })
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ProtocolPayload;
  assert.equal(payload.object, "chat.completion");
  assert.equal(payload.choices?.[0]?.message?.content, "ok");

  assert.equal(mock.chatBodies.length, 1);
  assert.equal(mock.chatBodies[0].model, "deepseek/deepseek-v4-flash");
  assert.deepEqual(mock.chatBodies[0].messages, [{ role: "user", content: "chat protocol" }]);
  assert.ok(mock.calls.some((call) => call.url.endsWith("/api/v1/freebuff/session/admission")));
});

test("P5 Chat Completions preserves tool-call IDs, names, and results across turns", async () => {
  const mock = createFreebuffMock((body) =>
    Array.isArray(body.messages) &&
    body.messages.some((message) => (message as { role?: unknown })?.role === "tool")
      ? chatResponse("tool result accepted")
      : toolCallResponse()
  );
  mock.install();

  const first = await chatRoute.POST(
    buildRequest({
      body: modelBody({
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_weather",
              description: "look up weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    })
  );
  const firstPayload = (await first.json()) as ProtocolPayload;
  assert.equal(first.status, 200);
  assert.equal(firstPayload.choices?.[0]?.message?.tool_calls?.[0]?.id, "call_p5_weather");
  assert.equal(
    firstPayload.choices?.[0]?.message?.tool_calls?.[0]?.function?.name,
    "lookup_weather"
  );

  const second = await chatRoute.POST(
    buildRequest({
      body: modelBody({
        messages: [
          { role: "user", content: "What is the weather?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_p5_weather",
                type: "function",
                function: { name: "lookup_weather", arguments: JSON.stringify({ city: "Dhaka" }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_p5_weather", name: "lookup_weather", content: "31C" },
        ],
      }),
    })
  );
  const secondPayload = (await second.json()) as ProtocolPayload;
  assert.equal(second.status, 200);
  assert.equal(secondPayload.choices?.[0]?.message?.content, "tool result accepted");

  assert.equal(mock.chatBodies.length, 2);
  const forwardedMessages = mock.chatBodies[1].messages as Array<Record<string, unknown>>;
  assert.deepEqual(forwardedMessages[1]?.tool_calls, [
    {
      id: "call_p5_weather",
      type: "function",
      function: { name: "lookup_weather", arguments: JSON.stringify({ city: "Dhaka" }) },
    },
  ]);
  assert.deepEqual(forwardedMessages[2], {
    role: "tool",
    tool_call_id: "call_p5_weather",
    name: "lookup_weather",
    content: "31C",
  });
});

test("P5 Responses route converts stateless input/instructions through the shared Chat path", async () => {
  const mock = createFreebuffMock();
  mock.install();

  const response = await responsesRoute.POST(
    buildRequest({
      url: "http://localhost/v1/responses",
      body: {
        model: "fb/deepseek/deepseek-v4-flash",
        instructions: "You are concise.",
        input: [{ role: "user", content: [{ type: "input_text", text: "say hello" }] }],
        stream: false,
      },
    })
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ProtocolPayload;
  assert.equal(payload.object, "response");
  assert.equal(payload.output?.[0]?.type, "message");
  assert.equal(payload.output?.[0]?.content?.[0]?.type, "output_text");
  assert.match(String(payload.output?.[0]?.content?.[0]?.text), /ok/);

  const forwarded = mock.chatBodies[0];
  assert.deepEqual(forwarded.messages, [
    { role: "system", content: "You are concise." },
    { role: "user", content: [{ type: "text", text: "say hello" }] },
  ]);
  assert.equal(forwarded.model, "deepseek/deepseek-v4-flash");
});

test("P5 Anthropic Messages route converts content blocks and preserves Claude response shape", async () => {
  const mock = createFreebuffMock(() => anthropicInputResponse());
  mock.install();

  const response = await messagesRoute.POST(
    buildRequest({
      url: "http://localhost/v1/messages",
      body: {
        model: "fb/deepseek/deepseek-v4-flash",
        max_tokens: 32,
        system: "Be concise.",
        messages: [{ role: "user", content: [{ type: "text", text: "say hello" }] }],
        stream: false,
      },
    })
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ProtocolPayload;
  assert.equal(payload.type, "message");
  assert.equal(payload.role, "assistant");
  assert.equal(payload.content?.[0]?.type, "text");
  assert.match(String(payload.content?.[0]?.text), /anthropic-compatible/);

  const forwarded = mock.chatBodies[0];
  assert.deepEqual(forwarded.messages, [
    { role: "system", content: "Be concise." },
    { role: "user", content: "say hello" },
  ]);
  assert.equal(forwarded.model, "deepseek/deepseek-v4-flash");
});

test("P5 Anthropic tool-use continuity preserves IDs through a second turn", async () => {
  const mock = createFreebuffMock((body) =>
    Array.isArray(body.messages) &&
    body.messages.some((message) => (message as { role?: unknown })?.role === "tool")
      ? chatResponse("tool result accepted")
      : toolCallResponse()
  );
  mock.install();

  const first = await messagesRoute.POST(
    buildRequest({
      url: "http://localhost/v1/messages",
      body: {
        model: "fb/deepseek/deepseek-v4-flash",
        max_tokens: 32,
        messages: [{ role: "user", content: "use the weather tool" }],
        tools: [
          {
            name: "lookup_weather",
            description: "look up weather",
            input_schema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        stream: false,
      },
    })
  );
  const firstPayload = (await first.json()) as ProtocolPayload;
  assert.equal(first.status, 200);
  const toolUseBlock = firstPayload.content?.find((block) => block.type === "tool_use");
  assert.ok(toolUseBlock);
  assert.equal(toolUseBlock.id, "call_p5_weather");

  const second = await messagesRoute.POST(
    buildRequest({
      url: "http://localhost/v1/messages",
      body: {
        model: "fb/deepseek/deepseek-v4-flash",
        max_tokens: 32,
        messages: [
          { role: "user", content: "use the weather tool" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_p5_weather",
                name: "lookup_weather",
                input: { city: "Dhaka" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_p5_weather",
                content: "31C",
              },
            ],
          },
        ],
        stream: false,
      },
    })
  );
  const secondPayload = (await second.json()) as ProtocolPayload;
  assert.equal(second.status, 200);
  assert.match(String(secondPayload.content?.[0]?.text), /tool result accepted/);

  const forwarded = mock.chatBodies[1].messages as Array<Record<string, unknown>>;
  assert.deepEqual(forwarded[1]?.tool_calls, [
    {
      id: "call_p5_weather",
      type: "function",
      function: { name: "lookup_weather", arguments: JSON.stringify({ city: "Dhaka" }) },
    },
  ]);
  assert.deepEqual(forwarded[2], {
    role: "tool",
    tool_call_id: "call_p5_weather",
    content: "31C",
  });
});

test("P5 streaming route preserves terminal SSE and finalizes the run", async () => {
  const mock = createFreebuffMock(() => chatStreamResponse());
  mock.install();

  const response = await chatRoute.POST(
    buildRequest({
      body: modelBody({
        stream: true,
        messages: [{ role: "user", content: "stream protocol" }],
      }),
    })
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /data: \[DONE\]/);
  assert.equal(
    mock.calls.some(
      (call) => call.url.endsWith("/api/v1/agent-runs") && call.body?.action === "FINISH"
    ),
    true
  );
});

test("P5 health snapshot is sanitized and does not perform network work", () => {
  const runtime = getSharedFreebuffRuntime();
  const snapshot = getFreebuffHealthSnapshot({
    configured: true,
    runtime,
    catalog: getFreebuffCatalogSnapshot(),
    nowMs: 10_000,
  });
  assert.equal(snapshot.configured, true);
  assert.ok(["healthy", "degraded"].includes(snapshot.status));
  assert.equal(snapshot.runtime.scheduler.active, 0);
  assert.equal(snapshot.runtime.scheduler.queued, 0);
  assert.equal(snapshot.runtime.sessions.accounts, 0);
  assert.equal("instanceId" in snapshot, false);
  assert.equal("token" in snapshot, false);
  assert.equal("warning" in snapshot.requests, false);
});

test("P5 Responses preserves named tool choice and multiple call/result IDs across turns", async () => {
  const mock = createFreebuffMock((body) =>
    Array.isArray(body.messages) &&
    body.messages.some((message) => (message as { role?: unknown })?.role === "tool")
      ? chatResponse("both tool results accepted")
      : multiToolCallResponse()
  );
  mock.install();

  const tools = [
    {
      type: "function",
      name: "lookup_weather",
      description: "look up weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
    {
      type: "function",
      name: "lookup_time",
      description: "look up local time",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  ];
  const first = await responsesRoute.POST(
    buildRequest({
      url: "http://localhost/v1/responses",
      body: {
        model: "fb/deepseek/deepseek-v4-flash",
        input: "Use both tools.",
        tools,
        tool_choice: { type: "function", name: "lookup_weather" },
        stream: false,
      },
    })
  );
  assert.equal(first.status, 200);
  const firstPayload = (await first.json()) as ProtocolPayload;
  const calls = firstPayload.output?.filter((item) => item.type === "function_call") ?? [];
  assert.deepEqual(
    calls.map((item) => [item.call_id, item.name]),
    [
      ["call_p5_weather", "lookup_weather"],
      ["call_p5_time", "lookup_time"],
    ]
  );
  assert.deepEqual(mock.chatBodies[0].tool_choice, {
    type: "function",
    function: { name: "lookup_weather" },
  });

  const second = await responsesRoute.POST(
    buildRequest({
      url: "http://localhost/v1/responses",
      body: {
        model: "fb/deepseek/deepseek-v4-flash",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Use both tools." }] },
          {
            type: "function_call",
            call_id: "call_p5_weather",
            name: "lookup_weather",
            arguments: JSON.stringify({ city: "Dhaka" }),
          },
          {
            type: "function_call",
            call_id: "call_p5_time",
            name: "lookup_time",
            arguments: JSON.stringify({ city: "Dhaka" }),
          },
          {
            type: "function_call_output",
            call_id: "call_p5_weather",
            output: "31C",
          },
          {
            type: "function_call_output",
            call_id: "call_p5_time",
            output: "15:30",
          },
        ],
        tools,
        stream: false,
      },
    })
  );
  assert.equal(second.status, 200);
  const secondPayload = (await second.json()) as ProtocolPayload;
  assert.match(String(secondPayload.output?.[0]?.content?.[0]?.text), /both tool results accepted/);

  const forwarded = mock.chatBodies[1].messages as Array<Record<string, unknown>>;
  assert.deepEqual(
    (
      forwarded.find((message) => message.role === "assistant")?.tool_calls as Array<{
        id?: string;
      }>
    ).map((call) => call.id),
    ["call_p5_weather", "call_p5_time"]
  );
  assert.deepEqual(
    forwarded
      .filter((message) => message.role === "tool")
      .map((message) => [message.tool_call_id, message.content]),
    [
      ["call_p5_weather", "31C"],
      ["call_p5_time", "15:30"],
    ]
  );
});

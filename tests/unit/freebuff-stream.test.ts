import assert from "node:assert/strict";
import test from "node:test";

import {
  wrapFreebuffResponse,
  type FreebuffResponseSettlement,
} from "../../open-sse/executors/freebuff/responseStream.ts";
import { readFreebuffFixture, readFreebuffFixtureJson } from "./helpers/freebuff-fixtures.ts";

function responseFromChunks(chunks: Uint8Array[], contentType: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": contentType } });
}

function utf8Chunks(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size));
  }
  return chunks;
}

async function consumeWrapped(
  response: Response,
  protocol: "sse" | "json",
  options: { maxEventBytes?: number; maxJsonBytes?: number } = {}
): Promise<{ body: Uint8Array; statuses: FreebuffResponseSettlement[] }> {
  const statuses: FreebuffResponseSettlement[] = [];
  const wrapped = wrapFreebuffResponse(response, {
    protocol,
    ...options,
    onSettled: (status) => {
      statuses.push(status);
    },
  });
  const body = new Uint8Array(await wrapped.arrayBuffer());
  return { body, statuses };
}

test("Freebuff stream: parses every byte boundary and preserves text SSE bytes", async () => {
  const fixture = readFreebuffFixture("chat-stream.sse");
  const result = await consumeWrapped(
    responseFromChunks(utf8Chunks(fixture, 1), "text/event-stream"),
    "sse"
  );

  assert.equal(new TextDecoder().decode(result.body), fixture);
  assert.deepEqual(result.statuses, ["completed"]);
});

test("Freebuff stream: preserves fragmented tool-call SSE bytes", async () => {
  const fixture = readFreebuffFixture("chat-stream-tool.sse");
  const result = await consumeWrapped(
    responseFromChunks(utf8Chunks(fixture, 2), "text/event-stream"),
    "sse"
  );

  assert.equal(new TextDecoder().decode(result.body), fixture);
  assert.deepEqual(result.statuses, ["completed"]);
  assert.match(fixture, /fixture_tool/);
  assert.match(fixture, /README\.md/);
});

test("Freebuff stream: handles comments, CRLF and multiline data", async () => {
  const fixture =
    ": synthetic comment\r\n" +
    "event: message\r\n" +
    'data: {"id":\r\n' +
    'data: "fixture-multiline"}\r\n' +
    "\r\n" +
    "data: [DONE]\r\n" +
    "\r\n";
  const result = await consumeWrapped(
    responseFromChunks(utf8Chunks(fixture, 3), "text/event-stream"),
    "sse"
  );

  assert.equal(new TextDecoder().decode(result.body), fixture);
  assert.deepEqual(result.statuses, ["completed"]);
});

test("Freebuff stream: recognizes a terminal marker split across reads", async () => {
  const fixture = 'data: {\"id\":\"fixture\"}\n\ndata: [DO' + "NE]\n\n";
  const result = await consumeWrapped(
    responseFromChunks(utf8Chunks(fixture, 1), "text/event-stream"),
    "sse"
  );

  assert.deepEqual(result.statuses, ["completed"]);
});

test("Freebuff stream: truncated EOF is failed, not successful", async () => {
  const fixture = 'data: {\"id\":\"fixture\"}\n\n';
  const statuses: FreebuffResponseSettlement[] = [];
  const wrapped = wrapFreebuffResponse(
    responseFromChunks(utf8Chunks(fixture, 4), "text/event-stream"),
    {
      protocol: "sse",
      onSettled: (status) => statuses.push(status),
    }
  );

  await assert.rejects(wrapped.arrayBuffer(), /terminal/i);
  assert.deepEqual(statuses, ["failed"]);
});

test("Freebuff stream: upstream error frame after partial output fails the response", async () => {
  const fixture =
    'data: {\"id\":\"fixture\",\"choices\":[]}\n\n' +
    'event: error\ndata: {\"error\":{\"message\":\"synthetic\"}}\n\n';
  const statuses: FreebuffResponseSettlement[] = [];
  const wrapped = wrapFreebuffResponse(
    responseFromChunks(utf8Chunks(fixture, 5), "text/event-stream"),
    {
      protocol: "sse",
      onSettled: (status) => statuses.push(status),
    }
  );

  await assert.rejects(wrapped.arrayBuffer(), /stream error/i);
  assert.deepEqual(statuses, ["failed"]);
});

test("Freebuff stream: malformed event and oversized event fail closed", async () => {
  const malformed = wrapFreebuffResponse(
    responseFromChunks(utf8Chunks("data: {not-json}\n\ndata: [DONE]\n\n", 2), "text/event-stream"),
    { protocol: "sse" }
  );
  await assert.rejects(malformed.arrayBuffer(), /malformed JSON/i);

  const oversized = wrapFreebuffResponse(
    responseFromChunks(
      utf8Chunks(`data: {"value":"${"x".repeat(80)}"}\n\ndata: [DONE]\n\n`, 7),
      "text/event-stream"
    ),
    { protocol: "sse", maxEventBytes: 32 }
  );
  await assert.rejects(oversized.arrayBuffer(), /size limit/i);
});

test("Freebuff stream: non-streaming JSON owns the same body lifetime", async () => {
  const payload = readFreebuffFixtureJson("chat-response.json");
  const fixture = JSON.stringify(payload);
  const result = await consumeWrapped(
    responseFromChunks(utf8Chunks(fixture, 3), "application/json"),
    "json"
  );

  assert.equal(new TextDecoder().decode(result.body), fixture);
  assert.deepEqual(result.statuses, ["completed"]);
});

test("Freebuff stream: malformed non-streaming JSON is failed", async () => {
  const statuses: FreebuffResponseSettlement[] = [];
  const wrapped = wrapFreebuffResponse(
    responseFromChunks(utf8Chunks("{not-json", 1), "application/json"),
    {
      protocol: "json",
      onSettled: (status) => statuses.push(status),
    }
  );

  await assert.rejects(wrapped.arrayBuffer(), /malformed JSON/i);
  assert.deepEqual(statuses, ["failed"]);
});

test("Freebuff stream: validation failure cancels the upstream reader", async () => {
  let cancelled = false;
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {not-json}\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
  const wrapped = wrapFreebuffResponse(upstream, { protocol: "sse" });

  await assert.rejects(wrapped.arrayBuffer(), /malformed JSON/i);
  assert.equal(cancelled, true);
});

test("Freebuff stream: downstream cancellation cancels the upstream reader", async () => {
  let release!: () => void;
  let cancelled = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() {
        cancelled = true;
        release();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
  const statuses: FreebuffResponseSettlement[] = [];
  const wrapped = wrapFreebuffResponse(upstream, {
    protocol: "sse",
    onSettled: (status) => statuses.push(status),
  });
  const reader = wrapped.body!.getReader();
  const pending = reader.read();
  await Promise.resolve();
  await reader.cancel("fixture client cancellation");
  release();

  const pendingResult = await pending;
  assert.equal(pendingResult.done, true);
  assert.equal(cancelled, true);
  assert.deepEqual(statuses, ["cancelled"]);
});

test("Freebuff stream: caller abort cancels the upstream reader", async () => {
  let release!: () => void;
  let cancelled = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      async start(streamController) {
        await gate;
        streamController.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        streamController.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
  const statuses: FreebuffResponseSettlement[] = [];
  const wrapped = wrapFreebuffResponse(upstream, {
    protocol: "sse",
    signal: controller.signal,
    onSettled: (status) => statuses.push(status),
  });
  const reader = wrapped.body!.getReader();
  const pending = reader.read();
  await Promise.resolve();
  controller.abort(new DOMException("fixture cancel", "AbortError"));
  release();

  await assert.rejects(pending);
  assert.equal(cancelled, true);
  assert.deepEqual(statuses, ["cancelled"]);
});

#!/usr/bin/env node

/**
 * Bounded, opt-in FreeBuff gateway smoke suite for P6.
 *
 * The FreeBuff token must already be stored in OmniRoute's provider connection.
 * This script accepts only an optional gateway API key, never searches for or
 * prints provider credentials, and is not invoked by normal CI.
 */

import { execFileSync } from "node:child_process";

const MAX_REQUESTS = 8;
const MAX_RUNTIME_MS = 90_000;
const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

class SmokeError extends Error {
  constructor(category, status) {
    super(category);
    this.category = category;
    this.status = status;
  }
}

function envInt(name, fallback, max) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

function gatewayUrl() {
  const raw = (process.env.FREEBUFF_LIVE_GATEWAY_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function urlFor(base, path) {
  return new URL(path.replace(/^\//, ""), `${base.toString().replace(/\/$/, "")}/`);
}

function modelMatches(actual, requested) {
  return typeof actual === "string" && (actual === requested || actual.endsWith(`/${requested}`));
}

function sha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function category(error) {
  if (error instanceof SmokeError) return error.category;
  if (error?.name === "TimeoutError") return "timeout";
  if (error?.name === "AbortError") return "aborted";
  if (error instanceof TypeError) return "network";
  return "unexpected";
}

async function jsonBody(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new SmokeError("response_too_large");
  try {
    return JSON.parse(text);
  } catch {
    throw new SmokeError("malformed_json");
  }
}

async function boundedFetch(base, path, init, state, deadline) {
  if (Date.now() >= deadline) throw new SmokeError("suite_deadline");
  if (state.requests >= MAX_REQUESTS) throw new SmokeError("request_budget_exhausted");
  state.requests += 1;
  const timeout = AbortSignal.timeout(state.timeoutMs);
  try {
    const response = await fetch(urlFor(base, path), {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new SmokeError(`http_${response.status}`, response.status);
    return response;
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    if (timeout.aborted) throw new SmokeError("timeout");
    if (init.signal?.aborted) throw new SmokeError("aborted");
    throw error;
  }
}

async function post(base, path, headers, body, state, deadline) {
  const response = await boundedFetch(
    base,
    path,
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) },
    state,
    deadline
  );
  return jsonBody(response);
}

async function consumeSse(response) {
  if (!response.body) throw new SmokeError("missing_stream_body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let frames = 0;
  let terminal = false;
  let returnedModel;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SmokeError("stream_too_large");
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        frames += 1;
        if (data === "[DONE]") {
          terminal = true;
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          if (typeof parsed?.model === "string") returnedModel = parsed.model;
          if (parsed?.choices?.some?.((choice) => choice?.finish_reason)) terminal = true;
          if (["response.completed", "message_stop"].includes(parsed?.type)) terminal = true;
        } catch {
          throw new SmokeError("malformed_sse");
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!terminal) throw new SmokeError("truncated_stream");
  return { frames, returnedModel };
}

async function step(name, fn, evidence) {
  const started = Date.now();
  try {
    const result = await fn();
    evidence.push({ name, result: result?.result ?? "pass", latencyMs: Date.now() - started, ...result });
  } catch (error) {
    evidence.push({
      name,
      result: "fail",
      latencyMs: Date.now() - started,
      ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
      errorCategory: category(error),
    });
  }
}

async function main() {
  if (process.env.FREEBUFF_LIVE_ENABLE !== "1") {
    console.log("LIVE FREEBUFF SMOKE SKIPPED: set FREEBUFF_LIVE_ENABLE=1 to opt in");
    return 0;
  }

  const base = gatewayUrl();
  const model = (process.env.FREEBUFF_LIVE_MODEL ?? "").trim();
  const gatewayKey = (process.env.FREEBUFF_LIVE_GATEWAY_API_KEY ?? "").trim();
  const unauthLoopback =
    process.env.FREEBUFF_LIVE_ALLOW_UNAUTH === "1" && base?.hostname === "127.0.0.1";
  if (!base || !model || (!gatewayKey && !unauthLoopback)) {
    console.log("LIVE FREEBUFF VALIDATION BLOCKED: AUTHORIZED ACCESS REQUIRED");
    return 0;
  }

  const headers = { accept: "application/json", ...(gatewayKey ? { authorization: `Bearer ${gatewayKey}` } : {}) };
  const state = { requests: 0, timeoutMs: envInt("FREEBUFF_LIVE_REQUEST_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 30_000) };
  const deadline = Date.now() + MAX_RUNTIME_MS;
  const evidence = [];

  await step("basic_completion", async () => {
    const body = await post(base, "/v1/chat/completions", headers, {
      model,
      messages: [{ role: "user", content: "Return only the word OK." }],
      max_tokens: 4,
      stream: false,
    }, state, deadline);
    if (!Array.isArray(body?.choices) || body.choices.length === 0) throw new SmokeError("missing_completion_choices");
    return { returnedModel: body.model, downgrade: modelMatches(body.model, model) ? false : "unknown" };
  }, evidence);

  await step("streaming_completion", async () => {
    const response = await boundedFetch(base, "/v1/chat/completions", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Return one short word." }], max_tokens: 4, stream: true }),
    }, state, deadline);
    return { stream: true, ...(await consumeSse(response)) };
  }, evidence);

  const tool = {
    type: "function",
    function: {
      name: "report_status",
      description: "Return a fixed harmless status.",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    },
  };
  await step("tool_cycle", async () => {
    const first = await post(base, "/v1/chat/completions", headers, {
      model,
      messages: [{ role: "user", content: "Call report_status with value ready." }],
      tools: [tool],
      tool_choice: { type: "function", function: { name: "report_status" } },
      max_tokens: 32,
      stream: false,
    }, state, deadline);
    const message = first?.choices?.[0]?.message;
    const call = message?.tool_calls?.[0];
    if (!call?.id || !call?.function?.name) return { result: "unsupported", errorCategory: "tool_call_not_returned" };
    if (call.function.name !== "report_status" || typeof call.function.arguments !== "string") throw new SmokeError("tool_call_shape");
    JSON.parse(call.function.arguments);
    const second = await post(base, "/v1/chat/completions", headers, {
      model,
      messages: [
        { role: "user", content: "Call report_status with value ready." },
        message,
        { role: "tool", tool_call_id: call.id, name: call.function.name, content: "status-ok" },
      ],
      max_tokens: 8,
      stream: false,
    }, state, deadline);
    if (!Array.isArray(second?.choices) || second.choices.length === 0) throw new SmokeError("tool_continuation_missing");
    return { toolId: call.id, toolName: call.function.name };
  }, evidence);

  await step("responses_translation", async () => {
    const body = await post(base, "/v1/responses", headers, { model, instructions: "Return only the word OK.", input: "Say OK.", max_output_tokens: 4, stream: false }, state, deadline);
    if (typeof body?.id !== "string" || !Array.isArray(body?.output)) throw new SmokeError("responses_shape");
    return {};
  }, evidence);

  await step("anthropic_messages_translation", async () => {
    const body = await post(base, "/v1/messages", { ...headers, "x-api-key": gatewayKey || "loopback-unauthenticated-test", "anthropic-version": "2023-06-01" }, {
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Return only the word OK." }],
      stream: false,
    }, state, deadline);
    if (!Array.isArray(body?.content) || body.content.length === 0) throw new SmokeError("anthropic_shape");
    return {};
  }, evidence);

  await step("cancellation", async () => {
    if (Date.now() >= deadline) throw new SmokeError("suite_deadline");
    if (state.requests >= MAX_REQUESTS) throw new SmokeError("request_budget_exhausted");
    state.requests += 1;
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(state.timeoutMs);
    let settled = false;
    const request = fetch(urlFor(base, "/v1/chat/completions"), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Produce a long harmless stream." }], max_tokens: 64, stream: true }),
      signal: AbortSignal.any([controller.signal, timeout]),
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, envInt("FREEBUFF_LIVE_CANCEL_AFTER_MS", 250, 2_000)));
    if (settled) {
      await request.catch(() => undefined);
      return { result: "not_proven", errorCategory: "response_completed_before_cancel" };
    }
    controller.abort();
    await request.catch(() => undefined);
    if (timeout.aborted && !controller.signal.aborted) throw new SmokeError("timeout");
    return {};
  }, evidence);

  await step("capability_truthfulness", async () => {
    const response = await boundedFetch(base, "/v1/models", { method: "GET", headers }, state, deadline);
    const body = await jsonBody(response);
    const row = Array.isArray(body?.data) ? body.data.find((candidate) => modelMatches(candidate?.id, model)) : null;
    if (!row) throw new SmokeError("model_not_listed");
    const capabilities = row.capabilities && typeof row.capabilities === "object" ? row.capabilities : {};
    const unsupported = Object.entries(capabilities).filter(([key, value]) => value === true && key !== "chat").map(([key]) => key);
    return unsupported.length === 0 ? {} : { result: "review", errorCategory: "unverified_capability_metadata" };
  }, evidence);

  const failed = evidence.filter((item) => item.result === "fail").length;
  console.log(JSON.stringify({
    timestampUtc: new Date().toISOString(),
    commitSha: sha(),
    gatewayOrigin: base.origin,
    requestedModel: model,
    requestCount: state.requests,
    requestLimit: MAX_REQUESTS,
    executionTimeMs: MAX_RUNTIME_MS - Math.max(0, deadline - Date.now()),
    result: failed === 0 ? "completed" : "failed",
    evidence,
  }, null, 2));
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();

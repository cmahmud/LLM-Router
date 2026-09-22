import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FreebuffFetchCall {
  url: string;
  init: RequestInit;
  bodyText: string;
  bodyJson: unknown;
}

export interface FreebuffFetchStep {
  match?: RegExp | ((call: FreebuffFetchCall) => boolean);
  response?: Response | (() => Response | Promise<Response>);
  error?: Error;
}

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../../fixtures/freebuff");

export function readFreebuffFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

export function readFreebuffFixtureJson<T = unknown>(name: string): T {
  return JSON.parse(readFreebuffFixture(name)) as T;
}

export function freebuffFixtureResponse(name: string, init: ResponseInit = {}): Response {
  const isSse = name.endsWith(".sse");
  return new Response(readFreebuffFixture(name), {
    ...init,
    headers: {
      "Content-Type": isSse ? "text/event-stream" : "application/json",
      ...(init.headers || {}),
    },
  });
}

export function deferredFreebuffResponse(
  chunks: string[] = [readFreebuffFixture("chat-stream.sse")]
): {
  response: Response;
  release: () => void;
  fail: (error?: Error) => void;
} {
  let releaseGate!: () => void;
  let failGate!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    releaseGate = resolve;
    failGate = reject;
  });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await gate;
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }),
    release: releaseGate,
    fail: (error = new Error("synthetic fixture stream failure")) => failGate(error),
  };
}

function matches(matcher: FreebuffFetchStep["match"], call: FreebuffFetchCall): boolean {
  if (!matcher) return true;
  if (matcher instanceof RegExp) return matcher.test(call.url);
  return matcher(call);
}

function defaultFreebuffFallback(call: FreebuffFetchCall): Response {
  if (
    call.url.endsWith("/api/v1/freebuff/session") &&
    (call.init.method || "GET").toUpperCase() === "GET"
  ) {
    return new Response(JSON.stringify({ status: "none" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ _fixture: "synthetic", ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

export function createFreebuffFetchMock(
  steps: FreebuffFetchStep[],
  fallback?: FreebuffFetchStep["response"]
): {
  fetch: typeof globalThis.fetch;
  calls: FreebuffFetchCall[];
} {
  const pending = [...steps];
  const calls: FreebuffFetchCall[] = [];

  const fetchMock: typeof globalThis.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url || String(input);
    const requestInit: RequestInit = {
      ...(request
        ? {
            method: request.method,
            headers: request.headers,
            body: await request.text(),
          }
        : {}),
      ...init,
    };
    const bodyText = typeof requestInit.body === "string" ? requestInit.body : "";
    let bodyJson: unknown = undefined;
    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = undefined;
      }
    }
    const call = { url, init: requestInit, bodyText, bodyJson };
    calls.push(call);

    const index = pending.findIndex((step) => matches(step.match, call));
    if (index >= 0) {
      const step = pending.splice(index, 1)[0];
      if (step.error) throw step.error;
      const response = step.response;
      return typeof response === "function" ? await response() : response!;
    }

    if (fallback) {
      const response = typeof fallback === "function" ? await fallback() : fallback.clone();
      if (!response) {
        throw new Error(`No synthetic response configured for ${url}`);
      }
      return response;
    }

    return defaultFreebuffFallback(call);
  };

  return { fetch: fetchMock, calls };
}

export async function withFreebuffFetch<T>(
  fetchMock: typeof globalThis.fetch,
  operation: () => Promise<T>
): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    return await operation();
  } finally {
    globalThis.fetch = previous;
  }
}

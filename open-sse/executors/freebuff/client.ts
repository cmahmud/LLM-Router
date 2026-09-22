import type { z } from "zod";

import {
  freebuffAdmissionSchema,
  freebuffRunStartSchema,
  freebuffUserProbeSchema,
} from "./schemas.ts";
import {
  FREEBUFF_BASE_URL,
  FREEBUFF_CLEANUP_TIMEOUT_MS,
  FREEBUFF_HEADERS,
  FREEBUFF_MAX_JSON_BYTES,
  FREEBUFF_OPERATION_TIMEOUT_MS,
  FREEBUFF_PATHS,
  type FreebuffAdmission,
  type FreebuffRunStart,
  type FreebuffUserProbe,
} from "./types.ts";
import { FreebuffClientError, freebuffUpstreamStatusError } from "./errors.ts";

type JsonSchema<T> = z.ZodType<T>;

export function parseFreebuffRetryAfterMs(
  value: string | null,
  nowMs = Date.now()
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1000;
    return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : undefined;
  }
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

async function readBoundedText(
  response: Response,
  operation: string,
  maxBytes = FREEBUFF_MAX_JSON_BYTES
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FreebuffClientError(`Freebuff ${operation} response exceeded the size limit`, {
          status: 502,
          kind: "malformed",
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseJson<T>(text: string, schema: JsonSchema<T>, operation: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FreebuffClientError(`Freebuff ${operation} returned malformed JSON`, {
      status: 502,
      kind: "malformed",
    });
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new FreebuffClientError(`Freebuff ${operation} returned an invalid response shape`, {
      status: 502,
      kind: "malformed",
    });
  }
  return parsed.data;
}

function authorizationHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

export class FreebuffClient {
  constructor(
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
    private readonly timeoutMs = FREEBUFF_OPERATION_TIMEOUT_MS
  ) {}

  private async withTimeout<T>(
    operation: string,
    signal: AbortSignal | null | undefined,
    fn: (effectiveSignal: AbortSignal) => Promise<T>,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    const timeoutController = new AbortController();
    const timeoutError = new DOMException(`Freebuff ${operation} timed out`, "TimeoutError");
    const timeoutId = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
    const effectiveSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      return await fn(effectiveSignal);
    } catch (error) {
      if (error instanceof FreebuffClientError) throw error;
      if (signal?.aborted) {
        throw new FreebuffClientError(`Freebuff ${operation} was aborted`, {
          status: 499,
          kind: "aborted",
          cause: error,
        });
      }
      if (timeoutController.signal.aborted) {
        throw new FreebuffClientError(`Freebuff ${operation} timed out`, {
          status: 504,
          kind: "timeout",
          cause: error,
        });
      }
      throw new FreebuffClientError(`Freebuff ${operation} network request failed`, {
        status: 502,
        kind: "network",
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchJson<T>(params: {
    operation: string;
    url: string;
    init: RequestInit;
    signal?: AbortSignal | null;
    schema: JsonSchema<T>;
  }): Promise<T> {
    return this.withTimeout(params.operation, params.signal, async (effectiveSignal) => {
      const response = await this.fetchFn(params.url, {
        ...params.init,
        signal: effectiveSignal,
      });
      const retryAfterMs = parseFreebuffRetryAfterMs(response.headers.get("retry-after"));
      if (!response.ok) {
        throw freebuffUpstreamStatusError(params.operation, response.status, retryAfterMs);
      }
      const text = await readBoundedText(response, params.operation);
      return parseJson(text, params.schema, params.operation);
    });
  }

  private async parseSessionResponse(
    response: Response,
    operation: string
  ): Promise<FreebuffAdmission> {
    if (response.status === 404) return { status: "none" };

    const retryAfterMs = parseFreebuffRetryAfterMs(response.headers.get("retry-after"));
    const text = await readBoundedText(response, operation);
    let parsed: FreebuffAdmission;
    try {
      parsed = parseJson(text, freebuffAdmissionSchema, operation);
    } catch (error) {
      if (!response.ok) {
        throw freebuffUpstreamStatusError(operation, response.status, retryAfterMs);
      }
      throw error;
    }

    if (!response.ok) {
      if (parsed.status === "active" || response.status >= 500) {
        throw freebuffUpstreamStatusError(operation, response.status, retryAfterMs);
      }
    }

    if (parsed.retryAfterMs === undefined && retryAfterMs !== undefined) {
      parsed.retryAfterMs = retryAfterMs;
    }
    return parsed;
  }

  async probeUser(token: string, signal?: AbortSignal | null): Promise<FreebuffUserProbe> {
    return this.fetchJson({
      operation: "credential validation",
      url: `${FREEBUFF_BASE_URL}${FREEBUFF_PATHS.user}`,
      init: {
        method: "GET",
        headers: authorizationHeaders(token),
      },
      signal,
      schema: freebuffUserProbeSchema,
    });
  }

  async getSession(
    token: string,
    instanceId?: string,
    signal?: AbortSignal | null
  ): Promise<FreebuffAdmission> {
    return this.withTimeout("session reconciliation", signal, async (effectiveSignal) => {
      const response = await this.fetchFn(`${FREEBUFF_BASE_URL}${FREEBUFF_PATHS.session}`, {
        method: "GET",
        headers: {
          ...authorizationHeaders(token),
          ...(instanceId ? { [FREEBUFF_HEADERS.instanceId]: instanceId } : {}),
        },
        signal: effectiveSignal,
      });
      return this.parseSessionResponse(response, "session reconciliation");
    });
  }

  async admitSession(
    token: string,
    model: string,
    signal?: AbortSignal | null
  ): Promise<FreebuffAdmission> {
    return this.withTimeout("session admission", signal, async (effectiveSignal) => {
      const response = await this.fetchFn(`${FREEBUFF_BASE_URL}${FREEBUFF_PATHS.admission}`, {
        method: "POST",
        headers: {
          ...authorizationHeaders(token),
          [FREEBUFF_HEADERS.model]: model,
          [FREEBUFF_HEADERS.walletSpendLimit]: "0",
        },
        signal: effectiveSignal,
      });

      if (response.status === 404 || response.status === 405) {
        throw new FreebuffClientError(
          "Freebuff session admission endpoint is unavailable on this upstream",
          {
            status: 502,
            kind: "upstream",
            retryAfterMs: parseFreebuffRetryAfterMs(response.headers.get("retry-after")),
          }
        );
      }

      return this.parseSessionResponse(response, "session admission");
    });
  }

  async releaseSession(token: string, instanceId: string): Promise<void> {
    await this.withTimeout(
      "session cleanup",
      undefined,
      async (effectiveSignal) => {
        const response = await this.fetchFn(`${FREEBUFF_BASE_URL}${FREEBUFF_PATHS.session}`, {
          method: "DELETE",
          headers: {
            ...authorizationHeaders(token),
            [FREEBUFF_HEADERS.instanceId]: instanceId,
          },
          signal: effectiveSignal,
        });

        if (response.status === 404) return;
        if (!response.ok) {
          throw freebuffUpstreamStatusError(
            "session cleanup",
            response.status,
            parseFreebuffRetryAfterMs(response.headers.get("retry-after"))
          );
        }
      },
      FREEBUFF_CLEANUP_TIMEOUT_MS
    );
  }

  async startRun(
    token: string,
    agentId: string,
    signal?: AbortSignal | null
  ): Promise<FreebuffRunStart> {
    return this.fetchJson({
      operation: "agent run start",
      url: `${FREEBUFF_BASE_URL}${FREEBUFF_PATHS.agentRuns}`,
      init: {
        method: "POST",
        headers: {
          ...authorizationHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "START",
          agentId,
          ancestorRunIds: [],
        }),
      },
      signal,
      schema: freebuffRunStartSchema,
    });
  }

  async chatCompletion(params: {
    token: string;
    agentId: string;
    runId: string;
    instanceId: string;
    body: Record<string, unknown>;
    signal?: AbortSignal | null;
  }): Promise<Response> {
    return this.withTimeout("chat response start", params.signal, (effectiveSignal) =>
      this.fetchFn(`${FREEBUFF_BASE_URL}${FREEBUFF_PATHS.chatCompletions}`, {
        method: "POST",
        headers: {
          ...authorizationHeaders(params.token),
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          [FREEBUFF_HEADERS.instanceId]: params.instanceId,
          [FREEBUFF_HEADERS.runId]: params.runId,
          [FREEBUFF_HEADERS.agentId]: params.agentId,
        },
        body: JSON.stringify(params.body),
        signal: effectiveSignal,
      })
    );
  }

  async finishRun(params: {
    token: string;
    runId: string;
    status: "completed" | "failed" | "cancelled";
    totalSteps?: number;
    directCredits?: number;
    totalCredits?: number;
  }): Promise<void> {
    await this.withTimeout(
      "agent run finish",
      undefined,
      async (effectiveSignal) => {
        const payload: Record<string, unknown> = {
          action: "FINISH",
          runId: params.runId,
          status: params.status,
        };
        if (params.totalSteps !== undefined) payload.totalSteps = params.totalSteps;
        if (params.directCredits !== undefined) payload.directCredits = params.directCredits;
        if (params.totalCredits !== undefined) payload.totalCredits = params.totalCredits;

        const response = await this.fetchFn(`${FREEBUFF_BASE_URL}${FREEBUFF_PATHS.agentRuns}`, {
          method: "POST",
          headers: {
            ...authorizationHeaders(params.token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: effectiveSignal,
        });
        if (!response.ok) {
          throw freebuffUpstreamStatusError(
            "agent run finish",
            response.status,
            parseFreebuffRetryAfterMs(response.headers.get("retry-after"))
          );
        }
      },
      FREEBUFF_CLEANUP_TIMEOUT_MS
    );
  }
}

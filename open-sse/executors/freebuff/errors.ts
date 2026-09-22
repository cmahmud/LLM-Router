import { buildErrorBody } from "../../utils/error.ts";
import type { FreebuffNonActiveAdmissionStatus } from "./types.ts";

export type FreebuffClientErrorKind =
  | "auth"
  | "forbidden"
  | "rate_limit"
  | "upstream"
  | "network"
  | "timeout"
  | "aborted"
  | "malformed";

export class FreebuffClientError extends Error {
  readonly status: number;
  readonly kind: FreebuffClientErrorKind;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      status: number;
      kind: FreebuffClientErrorKind;
      retryAfterMs?: number;
      cause?: unknown;
    }
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FreebuffClientError";
    this.status = options.status;
    this.kind = options.kind;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function errorIdentifiers(kind: FreebuffClientErrorKind): { type: string; code: string } {
  switch (kind) {
    case "auth":
      return { type: "authentication_error", code: "authentication_error" };
    case "forbidden":
      return { type: "authentication_error", code: "forbidden" };
    case "rate_limit":
      return { type: "rate_limit_error", code: "rate_limited" };
    case "timeout":
      return { type: "timeout_error", code: "timeout_error" };
    case "network":
      return { type: "network_error", code: "network_error" };
    case "aborted":
      return { type: "client_cancelled", code: "aborted" };
    case "malformed":
    case "upstream":
    default:
      return { type: "upstream_error", code: "upstream_error" };
  }
}

function retryAfterHeader(retryAfterMs: number | undefined): Record<string, string> {
  if (!retryAfterMs || retryAfterMs <= 0) return {};
  return { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
}

export function freebuffErrorResponse(error: FreebuffClientError): Response {
  const identifiers = errorIdentifiers(error.kind);
  return new Response(
    JSON.stringify(buildErrorBody(error.status, error.message, undefined, identifiers)),
    {
      status: error.status,
      headers: {
        "Content-Type": "application/json",
        ...retryAfterHeader(error.retryAfterMs),
      },
    }
  );
}

export function freebuffAdmissionError(
  status: FreebuffNonActiveAdmissionStatus,
  retryAfterMs?: number
): FreebuffClientError {
  if (status === "rate_limited" || status === "spend_limited" || status === "ip_capped") {
    return new FreebuffClientError(`Freebuff session admission is rate limited (${status})`, {
      status: 429,
      kind: "rate_limit",
      retryAfterMs,
    });
  }

  if (status === "country_blocked" || status === "banned" || status === "consent_required") {
    return new FreebuffClientError(`Freebuff session admission was denied (${status})`, {
      status: 403,
      kind: "forbidden",
      retryAfterMs,
    });
  }

  if (status === "model_unavailable") {
    return new FreebuffClientError("The requested Freebuff model is currently unavailable", {
      status: 410,
      kind: "upstream",
      retryAfterMs,
    });
  }

  return new FreebuffClientError(`Freebuff session admission did not become active (${status})`, {
    status: 409,
    kind: "upstream",
    retryAfterMs,
  });
}

export function freebuffUpstreamStatusError(
  operation: string,
  status: number,
  retryAfterMs?: number
): FreebuffClientError {
  if (status === 401) {
    return new FreebuffClientError(`Freebuff ${operation} authentication failed`, {
      status: 401,
      kind: "auth",
      retryAfterMs,
    });
  }
  if (status === 403) {
    return new FreebuffClientError(`Freebuff ${operation} access was forbidden`, {
      status: 403,
      kind: "forbidden",
      retryAfterMs,
    });
  }
  if (status === 429) {
    return new FreebuffClientError(`Freebuff ${operation} is rate limited`, {
      status: 429,
      kind: "rate_limit",
      retryAfterMs,
    });
  }
  return new FreebuffClientError(`Freebuff ${operation} failed with HTTP ${status}`, {
    status: status >= 400 && status <= 599 ? status : 502,
    kind: "upstream",
    retryAfterMs,
  });
}

export function freebuffInvalidRequest(message: string): Response {
  return new Response(
    JSON.stringify(
      buildErrorBody(400, message, undefined, {
        type: "invalid_request_error",
        code: "invalid_request_error",
      })
    ),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

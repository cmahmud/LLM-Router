import type { FreebuffCatalogSnapshot } from "./catalog.ts";
import type { SharedFreebuffRuntime } from "./runtime.ts";

export type FreebuffHealthPhase = "admission" | "session" | "run" | "chat" | "cleanup";

type FreebuffHealthState = {
  totalRequests: number;
  failedRequests: number;
  totalLatencyMs: number;
  lastLatencyMs: number | null;
  lastErrorAtMs: number | null;
  errorsByPhase: Record<FreebuffHealthPhase, number>;
  errorsByKind: Record<string, number>;
};

const phases: readonly FreebuffHealthPhase[] = ["admission", "session", "run", "chat", "cleanup"];

function emptyState(): FreebuffHealthState {
  return {
    totalRequests: 0,
    failedRequests: 0,
    totalLatencyMs: 0,
    lastLatencyMs: null,
    lastErrorAtMs: null,
    errorsByPhase: Object.fromEntries(phases.map((phase) => [phase, 0])) as Record<
      FreebuffHealthPhase,
      number
    >,
    errorsByKind: {},
  };
}

let state = emptyState();

function sanitizeKind(error: unknown): string {
  const candidate = (error as { kind?: unknown } | null)?.kind;
  if (
    candidate === "auth" ||
    candidate === "forbidden" ||
    candidate === "rate_limit" ||
    candidate === "upstream" ||
    candidate === "network" ||
    candidate === "timeout" ||
    candidate === "aborted" ||
    candidate === "malformed"
  ) {
    return candidate;
  }

  const structured = error as { name?: unknown; code?: unknown } | null;
  if (structured?.name === "AbortError") return "aborted";
  if (structured?.code === "upstream_error") return "upstream";
  if (structured?.code === "malformed" || structured?.code === "missing_terminal") {
    return "malformed";
  }
  return "unknown";
}

/** Record a low-cardinality provider-local error without retaining the message. */
export function recordFreebuffPhaseError(phase: FreebuffHealthPhase, error: unknown): void {
  state.errorsByPhase[phase] += 1;
  const kind = sanitizeKind(error);
  state.errorsByKind[kind] = (state.errorsByKind[kind] ?? 0) + 1;
  state.lastErrorAtMs = Date.now();
}

/** Record one request at terminal lifecycle settlement, including full response-body latency. */
export function recordFreebuffRequestResult(
  outcome: "success" | "failure",
  latencyMs: number
): void {
  const boundedLatency = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : 0;
  state.totalRequests += 1;
  if (outcome === "failure") state.failedRequests += 1;
  state.totalLatencyMs += boundedLatency;
  state.lastLatencyMs = boundedLatency;
}

/**
 * Return sanitized FreeBuff health suitable for the authenticated monitoring payload.
 * This function never performs network work and never returns credential, session, run, or
 * upstream identifiers.
 */
export function getFreebuffHealthSnapshot(params: {
  configured: boolean;
  runtime: Pick<SharedFreebuffRuntime, "scheduler" | "sessions">;
  catalog: FreebuffCatalogSnapshot;
  nowMs?: number;
}): {
  configured: boolean;
  status: "healthy" | "degraded" | "not_configured";
  catalog: {
    status: FreebuffCatalogSnapshot["status"];
    sourceRevision: string;
    modelCount: number;
    pausedModelCount: number;
    refreshedAt: string | null;
    ageMs: number | null;
    stale: boolean;
    warning?: string;
  };
  runtime: {
    scheduler: { active: number; queued: number };
    sessions: ReturnType<SharedFreebuffRuntime["sessions"]["stats"]>;
  };
  requests: {
    total: number;
    failed: number;
    lastLatencyMs: number | null;
    averageLatencyMs: number | null;
    lastErrorAt: string | null;
    errorsByPhase: Record<FreebuffHealthPhase, number>;
    errorsByKind: Record<string, number>;
  };
} {
  const nowMs = params.nowMs ?? Date.now();
  const refreshedAtMs =
    Number.isFinite(params.catalog.refreshedAtMs) && params.catalog.refreshedAtMs > 0
      ? params.catalog.refreshedAtMs
      : null;
  const ageMs = refreshedAtMs === null ? null : Math.max(0, nowMs - refreshedAtMs);
  const stale = params.catalog.stale === true;
  const status = !params.configured
    ? "not_configured"
    : stale || params.catalog.status === "fallback"
      ? "degraded"
      : "healthy";

  return {
    configured: params.configured,
    status,
    catalog: {
      status: params.catalog.status,
      sourceRevision: params.catalog.sourceRevision,
      modelCount: params.catalog.models.length,
      pausedModelCount: params.catalog.pausedModelIds.length,
      refreshedAt: refreshedAtMs === null ? null : new Date(refreshedAtMs).toISOString(),
      ageMs,
      stale,
      ...(params.catalog.warning ? { warning: params.catalog.warning } : {}),
    },
    runtime: {
      scheduler: params.runtime.scheduler.stats(),
      sessions: params.runtime.sessions.stats(),
    },
    requests: {
      total: state.totalRequests,
      failed: state.failedRequests,
      lastLatencyMs: state.lastLatencyMs,
      averageLatencyMs:
        state.totalRequests > 0 ? Math.round(state.totalLatencyMs / state.totalRequests) : null,
      lastErrorAt:
        state.lastErrorAtMs === null ? null : new Date(state.lastErrorAtMs).toISOString(),
      errorsByPhase: { ...state.errorsByPhase },
      errorsByKind: { ...state.errorsByKind },
    },
  };
}

export function __resetFreebuffHealthForTests(): void {
  state = emptyState();
}

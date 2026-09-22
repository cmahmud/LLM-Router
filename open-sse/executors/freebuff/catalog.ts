import {
  parseFreebuffCatalog,
  type FreebuffCatalogSourceFiles,
  type ParsedFreebuffCatalog,
  type ParsedFreebuffModel,
} from "./catalogParser.ts";
import { FREEBUFF_FALLBACK_MODELS, FREEBUFF_FALLBACK_SOURCE_REVISION } from "./catalogFallback.ts";

export const FREEBUFF_OFFICIAL_REPOSITORY = "CodebuffAI/freebuff";
export const FREEBUFF_OFFICIAL_REVISION = "a37beff7a5db909eb6db54654431bb521af7da1a";
export const FREEBUFF_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FREEBUFF_STALE_CEILING_MS = 7 * 24 * 60 * 60 * 1000;
export const FREEBUFF_DISCOVERY_TIMEOUT_MS = 10_000;
export const FREEBUFF_MAX_SOURCE_BYTES = 384 * 1024;

const SOURCE_PATHS = {
  modelIds: "common/src/constants/freebuff-model-ids.ts",
  models: "common/src/constants/freebuff-models.ts",
  agents: "common/src/constants/free-agents.ts",
  modelConfig: "common/src/constants/model-config.ts",
  entitlements: "common/src/constants/freebuff-model-entitlements.ts",
} as const;

export const FREEBUFF_OFFICIAL_SOURCE_URLS = Object.freeze(
  Object.fromEntries(
    Object.entries(SOURCE_PATHS).map(([key, path]) => [
      key,
      "https://raw.githubusercontent.com/" +
        FREEBUFF_OFFICIAL_REPOSITORY +
        "/" +
        FREEBUFF_OFFICIAL_REVISION +
        "/" +
        path,
    ])
  )
) as Record<keyof typeof SOURCE_PATHS, string>;

export type FreebuffCatalogStatus = "official" | "last-known-good" | "fallback" | "empty";

export interface FreebuffCatalogSnapshot {
  status: FreebuffCatalogStatus;
  sourceRevision: string;
  models: readonly ParsedFreebuffModel[];
  pausedModelIds: readonly string[];
  refreshedAtMs: number;
  stale: boolean;
  warning?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type CatalogState = {
  current: FreebuffCatalogSnapshot;
  lastGood: FreebuffCatalogSnapshot | null;
  lastGoodAtMs: number;
  lastAttemptAtMs: number;
};

type RefreshOptions = {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: number;
  force?: boolean;
};

const initialSnapshot: FreebuffCatalogSnapshot = {
  status: "fallback",
  sourceRevision: FREEBUFF_FALLBACK_SOURCE_REVISION,
  models: FREEBUFF_FALLBACK_MODELS,
  pausedModelIds: [],
  refreshedAtMs: 0,
  stale: true,
  warning: "Official Freebuff catalog has not been refreshed",
};

let state: CatalogState = {
  current: initialSnapshot,
  lastGood: null,
  lastGoodAtMs: 0,
  lastAttemptAtMs: 0,
};

let inFlight: Promise<FreebuffCatalogSnapshot> | null = null;

function abortError(): Error {
  const error = new Error("Freebuff catalog refresh aborted");
  error.name = "AbortError";
  return error;
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function makeTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maxBytes) {
    throw new Error("Freebuff source exceeds the bounded size limit");
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("Freebuff source exceeds the bounded size limit");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Freebuff source exceeds the bounded size limit");
      }
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function fetchSource(
  url: string,
  fetchImpl: FetchLike,
  parentSignal: AbortSignal | undefined
): Promise<string> {
  const timeout = makeTimeoutSignal(parentSignal, FREEBUFF_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "text/plain" },
      signal: timeout.signal,
    });
    if (!response.ok) {
      throw new Error("Freebuff official source returned HTTP " + response.status);
    }
    return await readBoundedText(response, FREEBUFF_MAX_SOURCE_BYTES);
  } finally {
    timeout.cleanup();
  }
}

function sourceFile(content: string): { content: string; revision: string } {
  return { content, revision: FREEBUFF_OFFICIAL_REVISION };
}

function toSnapshot(parsed: ParsedFreebuffCatalog, now: number): FreebuffCatalogSnapshot {
  return {
    status: parsed.models.length === 0 ? "empty" : "official",
    sourceRevision: parsed.sourceRevision,
    models: parsed.models,
    pausedModelIds: parsed.pausedModelIds,
    refreshedAtMs: now,
    stale: false,
  };
}

async function performRefresh(options: RefreshOptions): Promise<FreebuffCatalogSnapshot> {
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.signal?.aborted) throw abortError();

  try {
    const entries = await Promise.all(
      Object.entries(FREEBUFF_OFFICIAL_SOURCE_URLS).map(async ([key, url]) => [
        key,
        await fetchSource(url, fetchImpl, options.signal),
      ])
    );
    if (options.signal?.aborted) throw abortError();

    const contents = Object.fromEntries(entries) as Record<keyof typeof SOURCE_PATHS, string>;
    const files: FreebuffCatalogSourceFiles = {
      modelIds: sourceFile(contents.modelIds),
      models: sourceFile(contents.models),
      agents: sourceFile(contents.agents),
      modelConfig: sourceFile(contents.modelConfig),
      entitlements: sourceFile(contents.entitlements),
    };
    const parsed = parseFreebuffCatalog(files);
    const snapshot = toSnapshot(parsed, now);
    state = {
      current: snapshot,
      lastGood: snapshot,
      lastGoodAtMs: now,
      lastAttemptAtMs: now,
    };
    return snapshot;
  } catch (error) {
    if (isAbortLike(error, options.signal)) throw abortError();

    state.lastAttemptAtMs = now;
    if (state.lastGood && now - state.lastGoodAtMs <= FREEBUFF_STALE_CEILING_MS) {
      const staleSnapshot: FreebuffCatalogSnapshot = {
        ...state.lastGood,
        status: state.lastGood.status === "empty" ? "empty" : "last-known-good",
        stale: true,
        warning: "Official Freebuff refresh failed; using last-known-good catalog",
      };
      state.current = staleSnapshot;
      return staleSnapshot;
    }

    const fallbackSnapshot: FreebuffCatalogSnapshot = {
      ...initialSnapshot,
      refreshedAtMs: now,
      warning: "Official Freebuff refresh failed; using emergency fallback",
    };
    state.current = fallbackSnapshot;
    return fallbackSnapshot;
  }
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

export function getFreebuffCatalogSnapshot(): FreebuffCatalogSnapshot {
  return state.current;
}

export async function refreshFreebuffCatalog(
  options: RefreshOptions = {}
): Promise<FreebuffCatalogSnapshot> {
  if (inFlight) return awaitWithSignal(inFlight, options.signal);
  inFlight = performRefresh(options).finally(() => {
    inFlight = null;
  });
  return awaitWithSignal(inFlight, options.signal);
}

export async function getFreebuffCatalog(
  options: RefreshOptions = {}
): Promise<FreebuffCatalogSnapshot> {
  const now = options.now ?? Date.now();
  const due =
    options.force === true ||
    state.lastAttemptAtMs === 0 ||
    now - state.lastAttemptAtMs >= FREEBUFF_REFRESH_INTERVAL_MS;
  if (!due) return awaitWithSignal(Promise.resolve(state.current), options.signal);
  return refreshFreebuffCatalog(options);
}

export function resolveFreebuffAgentIdFromCatalog(
  modelId: string,
  snapshot: FreebuffCatalogSnapshot = state.current
): string | null {
  const normalized = modelId.replace(/^(?:freebuff|fb)\//, "").trim();
  if (!normalized) return null;
  return snapshot.models.find((model) => model.id === normalized)?.agentId ?? null;
}

export function freebuffCatalogModelsForRegistry(
  snapshot: FreebuffCatalogSnapshot = state.current
): Array<{
  id: string;
  name: string;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  supportedEndpoints: string[];
  apiFormat: string;
}> {
  return snapshot.models.map((model) => ({
    id: model.id,
    name: model.displayName,
    ...(model.supportsReasoning !== undefined
      ? { supportsReasoning: model.supportsReasoning }
      : {}),
    ...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
    supportedEndpoints: ["chat"],
    apiFormat: "chat-completions",
  }));
}

export function __resetFreebuffCatalogForTest(): void {
  state = {
    current: initialSnapshot,
    lastGood: null,
    lastGoodAtMs: 0,
    lastAttemptAtMs: 0,
  };
  inFlight = null;
}

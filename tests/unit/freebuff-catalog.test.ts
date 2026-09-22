import test from "node:test";
import assert from "node:assert/strict";

import {
  FREEBUFF_DISCOVERY_TIMEOUT_MS,
  FREEBUFF_OFFICIAL_SOURCE_URLS,
  FREEBUFF_REFRESH_INTERVAL_MS,
  FREEBUFF_STALE_CEILING_MS,
  __resetFreebuffCatalogForTest,
  getFreebuffCatalog,
  getFreebuffCatalogSnapshot,
  freebuffCatalogModelsForRegistry,
  refreshFreebuffCatalog,
} from "../../open-sse/executors/freebuff/catalog.ts";

const modelIds = ['export const MODEL_ALPHA_MODEL_ID = "vendor/alpha";'].join("\n");
const models = [
  "const ALPHA_MODEL = {",
  "  id: MODEL_ALPHA_MODEL_ID,",
  '  displayName: "Alpha",',
  '  reasoningEffort: "high",',
  "  multimodal: true,",
  "};",
  "export const FREEBUFF_MODELS = [ALPHA_MODEL];",
  "export const FREEBUFF_PAUSED_FREE_MODEL_IDS = [];",
].join("\n");
const agents =
  'export const FREEBUFF_ROOT_AGENT_ID_BY_MODEL = { [MODEL_ALPHA_MODEL_ID]: "base2-free-alpha" };';

function sourceFixture(empty = false): Record<string, string> {
  return {
    [FREEBUFF_OFFICIAL_SOURCE_URLS.modelIds]: modelIds,
    [FREEBUFF_OFFICIAL_SOURCE_URLS.models]: empty
      ? "export const FREEBUFF_MODELS = []; export const FREEBUFF_PAUSED_FREE_MODEL_IDS = [];"
      : models,
    [FREEBUFF_OFFICIAL_SOURCE_URLS.agents]: agents,
    [FREEBUFF_OFFICIAL_SOURCE_URLS.modelConfig]: "",
    [FREEBUFF_OFFICIAL_SOURCE_URLS.entitlements]: "",
  };
}

function makeFetcher(
  fixture: Record<string, string>,
  options: { fail?: boolean; delayMs?: number } = {}
) {
  let calls = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls += 1;
    if (options.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.delayMs);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    }
    if (options.fail) throw new Error("synthetic upstream failure");
    const body = fixture[url];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
  return {
    fetchImpl,
    get calls() {
      return calls;
    },
  };
}

test("valid discovery is normalized and cached", async () => {
  __resetFreebuffCatalogForTest();
  const mock = makeFetcher(sourceFixture());
  const first = await refreshFreebuffCatalog({
    force: true,
    now: 1_000,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(first.status, "official");
  assert.deepEqual(
    first.models.map((model) => model.id),
    ["vendor/alpha"]
  );
  assert.equal(first.models[0]?.agentId, "base2-free-alpha");
  assert.equal(first.models[0]?.supportsReasoning, true);
  assert.equal(first.models[0]?.supportsVision, true);
  assert.deepEqual(freebuffCatalogModelsForRegistry(first), [
    {
      id: "vendor/alpha",
      name: "Alpha",
      supportsReasoning: true,
      supportsVision: true,
      supportedEndpoints: ["chat"],
      apiFormat: "chat-completions",
    },
  ]);
  assert.equal(mock.calls, 5);

  const cached = await getFreebuffCatalog({
    now: 1_000 + FREEBUFF_REFRESH_INTERVAL_MS - 1,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(cached, first);
  assert.equal(mock.calls, 5);
});

test("concurrent refreshes share one upstream fetch", async () => {
  __resetFreebuffCatalogForTest();
  const mock = makeFetcher(sourceFixture(), { delayMs: 5 });
  const [left, right] = await Promise.all([
    refreshFreebuffCatalog({ force: true, now: 2_000, fetchImpl: mock.fetchImpl }),
    refreshFreebuffCatalog({ force: true, now: 2_000, fetchImpl: mock.fetchImpl }),
  ]);
  assert.equal(left, right);
  assert.equal(mock.calls, 5);
});

test("refresh failures retain last-known-good, then enforce the stale ceiling", async () => {
  __resetFreebuffCatalogForTest();
  const good = makeFetcher(sourceFixture());
  await refreshFreebuffCatalog({ force: true, now: 10_000, fetchImpl: good.fetchImpl });

  const failed = makeFetcher(sourceFixture(), { fail: true });
  const withinCeiling = await refreshFreebuffCatalog({
    force: true,
    now: 10_000 + FREEBUFF_STALE_CEILING_MS - 1,
    fetchImpl: failed.fetchImpl,
  });
  assert.equal(withinCeiling.status, "last-known-good");
  assert.equal(withinCeiling.models[0]?.id, "vendor/alpha");

  const beyondCeiling = await refreshFreebuffCatalog({
    force: true,
    now: 10_000 + FREEBUFF_STALE_CEILING_MS + 1,
    fetchImpl: failed.fetchImpl,
  });
  assert.equal(beyondCeiling.status, "fallback");
  assert.ok(beyondCeiling.models.length > 0);
});

test("a valid empty source is not replaced by fallback rows", async () => {
  __resetFreebuffCatalogForTest();
  const empty = makeFetcher(sourceFixture(true));
  const result = await refreshFreebuffCatalog({
    force: true,
    now: 20_000,
    fetchImpl: empty.fetchImpl,
  });
  assert.equal(result.status, "empty");
  assert.deepEqual(result.models, []);
});

test("refresh cancellation propagates without changing the current snapshot", async () => {
  __resetFreebuffCatalogForTest();
  const before = getFreebuffCatalogSnapshot();
  const controller = new AbortController();
  const mock = makeFetcher(sourceFixture(), { delayMs: FREEBUFF_DISCOVERY_TIMEOUT_MS + 20 });
  const pending = refreshFreebuffCatalog({
    force: true,
    now: 30_000,
    fetchImpl: mock.fetchImpl,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /aborted/i);
  assert.equal(getFreebuffCatalogSnapshot(), before);
});

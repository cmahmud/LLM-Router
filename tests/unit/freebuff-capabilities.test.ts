import assert from "node:assert/strict";
import test from "node:test";

import { freebuffCatalogModelsForRegistry } from "../../open-sse/executors/freebuff/catalog.ts";
import { FREEBUFF_FALLBACK_MODELS } from "../../open-sse/executors/freebuff/catalogFallback.ts";

test("Freebuff capability projection advertises only chat and evidence-backed flags", () => {
  const rows = freebuffCatalogModelsForRegistry({
    status: "fallback",
    sourceRevision: "fixture",
    models: FREEBUFF_FALLBACK_MODELS,
    pausedModelIds: [],
    refreshedAtMs: 0,
    stale: true,
  });

  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.deepEqual(row.supportedEndpoints, ["chat"]);
    assert.equal(row.apiFormat, "chat-completions");
    assert.equal("supportsTools" in row, false);
    assert.equal("supportsResponses" in row, false);
    assert.equal("contextLength" in row, false);
    assert.equal("modalities" in row, false);
  }

  const reasoningUnknown = rows.find((row) => row.id === "mimo/mimo-v2.5");
  assert.ok(reasoningUnknown);
  assert.equal("supportsReasoning" in reasoningUnknown, false);

  const visionNegative = rows.find((row) => row.id === "upstage/solar-pro4");
  assert.ok(visionNegative);
  assert.equal(visionNegative.supportsVision, false);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseFreebuffCatalog,
  FreebuffCatalogParseError,
  type FreebuffCatalogSourceFiles,
} from "../../open-sse/executors/freebuff/catalogParser.ts";

function fixture(
  revision = "r1",
  options: { empty?: boolean; malicious?: boolean; conflict?: boolean } = {}
): FreebuffCatalogSourceFiles {
  const modelIds = [
    'export const MODEL_ALPHA = "vendor/alpha";',
    "export const MODEL_BETA = catalog.modelBeta;",
    'export const MODEL_GAMMA_MODEL_ID = "vendor/gamma";',
  ].join("\n");
  const modelConfig = ["export const catalog = {", '  modelBeta: "vendor/beta",', "};"].join("\n");
  const models = [
    "const ALPHA_MODEL = {",
    "  id: MODEL_ALPHA,",
    '  displayName: "Alpha",',
    '  reasoningEffort: "high",',
    "  multimodal: true,",
    "};",
    "const BETA_MODEL = {",
    "  id: MODEL_BETA,",
    '  displayName: "Beta",',
    "  multimodal: false,",
    "};",
    "const GAMMA_MODEL = {",
    "  id: MODEL_GAMMA_MODEL_ID,",
    '  displayName: "Gamma helper",',
    "  multimodal: true,",
    "};",
    "export const FREEBUFF_MODELS = " +
      (options.empty ? "[]" : "[ALPHA_MODEL, ...[BETA_MODEL, GAMMA_MODEL]]") +
      ";",
    "export const FREEBUFF_PAUSED_FREE_MODEL_IDS = [MODEL_GAMMA_MODEL_ID];",
  ].join("\n");
  const agents = [
    "export const FREEBUFF_ROOT_AGENT_ID_BY_MODEL = {",
    '  [MODEL_ALPHA]: "base2-free-alpha",',
    '  [MODEL_BETA]: "base2-free-beta",',
    '  [MODEL_GAMMA_MODEL_ID]: "base2-free-gamma",',
    options.conflict ? '  [MODEL_ALPHA]: "base2-free-other",' : "",
    "};",
  ].join("\n");
  const maliciousModels = [
    "const ALPHA_MODEL = {",
    "  id: process.env.SECRET,",
    '  displayName: "Alpha",',
    "};",
    "export const FREEBUFF_MODELS = [ALPHA_MODEL];",
    "export const FREEBUFF_PAUSED_FREE_MODEL_IDS = [];",
  ].join("\n");
  return {
    modelIds: { content: modelIds, revision },
    models: {
      content: options.malicious ? maliciousModels : models,
      revision,
    },
    agents: { content: agents, revision },
    modelConfig: { content: modelConfig, revision },
    entitlements: { content: "", revision },
  };
}

test("parses active models, imported constants, mappings, and capabilities", () => {
  const parsed = parseFreebuffCatalog(fixture());
  assert.deepEqual(
    parsed.models.map((model) => model.id),
    ["vendor/alpha", "vendor/beta"]
  );
  assert.equal(parsed.models[0]?.agentId, "base2-free-alpha");
  assert.equal(parsed.models[0]?.supportsReasoning, true);
  assert.equal(parsed.models[0]?.supportsVision, true);
  assert.equal(parsed.models[1]?.supportsVision, false);
  assert.deepEqual(parsed.pausedModelIds, ["vendor/gamma"]);
});

test("surface eligibility excludes helper and paused rows", () => {
  const parsed = parseFreebuffCatalog(fixture());
  assert.equal(
    parsed.models.some((model) => model.id === "vendor/gamma"),
    false
  );
});

test("surface eligibility follows literal feature flags without evaluating code", () => {
  const input = fixture();
  input.models = {
    ...input.models,
    content:
      "export const FREEBUFF_ENABLE_MIMO_MODELS_IN_UI = false;\n" +
      'const ALPHA_MODEL = { id: MODEL_ALPHA, displayName: "Alpha" };\n' +
      'const BETA_MODEL = { id: MODEL_BETA, displayName: "Beta" };\n' +
      "export const FREEBUFF_MODELS = [ALPHA_MODEL, ...(FREEBUFF_ENABLE_MIMO_MODELS_IN_UI ? [BETA_MODEL] : [])];\n" +
      "export const FREEBUFF_PAUSED_FREE_MODEL_IDS = [];",
  };
  const parsed = parseFreebuffCatalog(input);
  assert.deepEqual(
    parsed.models.map((model) => model.id),
    ["vendor/alpha"]
  );
});

test("valid empty catalog is represented without a fallback row", () => {
  const parsed = parseFreebuffCatalog(fixture("r1", { empty: true }));
  assert.deepEqual(parsed.models, []);
});

test("mixed revisions are rejected atomically", () => {
  const input = fixture();
  input.agents = { ...input.agents, revision: "r2" };
  assert.throws(() => parseFreebuffCatalog(input), FreebuffCatalogParseError);
});

test("conflicting duplicate mappings are rejected", () => {
  assert.throws(
    () => parseFreebuffCatalog(fixture("r1", { conflict: true })),
    /Conflicting root-agent mapping/
  );
});

test("unsupported expressions are rejected instead of evaluated", () => {
  assert.throws(
    () => parseFreebuffCatalog(fixture("r1", { malicious: true })),
    /supported id|Unresolved/
  );
});

test("missing mapping for an offered model is rejected", () => {
  const input = fixture();
  input.agents = {
    ...input.agents,
    content:
      'export const FREEBUFF_ROOT_AGENT_ID_BY_MODEL = { [MODEL_ALPHA]: "base2-free-alpha" };',
  };
  assert.throws(() => parseFreebuffCatalog(input), /base2 root mapping/);
});

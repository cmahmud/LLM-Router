import type { ParsedFreebuffModel } from "./catalogParser.ts";

/**
 * Emergency fallback generated from the official Freebuff source snapshot
 * a37beff7a5db909eb6db54654431bb521af7da1a.
 *
 * It intentionally contains only active base2 rows from FREEBUFF_MODELS after
 * FREEBUFF_PAUSED_FREE_MODEL_IDS filtering. Unknown capability fields are omitted.
 * Refreshing the official source is still the normal path.
 */
export const FREEBUFF_FALLBACK_SOURCE_REVISION = "a37beff7a5db909eb6db54654431bb521af7da1a";

export const FREEBUFF_FALLBACK_MODELS: readonly ParsedFreebuffModel[] = [
  {
    id: "z-ai/glm-5.3-flash",
    displayName: "GLM 5.3 Flash",
    agentId: "base2-free-glm-5-3-flash",
    sourceRevision: FREEBUFF_FALLBACK_SOURCE_REVISION,
    surfaces: ["base2"],
    supportsReasoning: true,
    supportsVision: true,
    availability: "active",
  },
  {
    id: "deepseek/deepseek-v4-flash",
    displayName: "DeepSeek V4.1 Flash",
    agentId: "base2-free-deepseek-flash",
    sourceRevision: FREEBUFF_FALLBACK_SOURCE_REVISION,
    surfaces: ["base2"],
    supportsReasoning: true,
    supportsVision: true,
    availability: "active",
  },
  {
    id: "openai/gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    agentId: "base2-free-luna",
    sourceRevision: FREEBUFF_FALLBACK_SOURCE_REVISION,
    surfaces: ["base2"],
    supportsReasoning: true,
    supportsVision: true,
    availability: "active",
  },
  {
    id: "mimo/mimo-v2.5",
    displayName: "MiMo 2.6 Flash",
    agentId: "base2-free-mimo",
    sourceRevision: FREEBUFF_FALLBACK_SOURCE_REVISION,
    surfaces: ["base2"],
    supportsVision: true,
    availability: "active",
  },
  {
    id: "mimo/mimo-v2.6-pro",
    displayName: "MiMo 2.6 Pro",
    agentId: "base2-free-mimo-2-6-pro",
    sourceRevision: FREEBUFF_FALLBACK_SOURCE_REVISION,
    surfaces: ["base2"],
    supportsVision: true,
    availability: "active",
  },
  {
    id: "upstage/solar-pro4",
    displayName: "Solar Pro 4",
    agentId: "base2-free-solar-pro4",
    sourceRevision: FREEBUFF_FALLBACK_SOURCE_REVISION,
    surfaces: ["base2"],
    supportsVision: false,
    availability: "active",
  },
  {
    id: "meta/muse-spark-1.2-contributor",
    displayName: "Muse Spark 1.2",
    agentId: "base2-free-muse-spark",
    sourceRevision: FREEBUFF_FALLBACK_SOURCE_REVISION,
    surfaces: ["base2"],
    supportsReasoning: true,
    supportsVision: false,
    availability: "active",
  },
  {
    id: "google/gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    agentId: "base2-free-gemini-3-8-flash",
    sourceRevision: FREEBUFF_FALLBACK_SOURCE_REVISION,
    surfaces: ["base2"],
    supportsReasoning: true,
    supportsVision: true,
    availability: "active",
  },
];

import { randomInt } from "node:crypto";

const MODEL_TO_AGENT: Readonly<Record<string, string>> = {
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "z-ai/glm-5.2": "base2-free-glm",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "anthropic/claude-fable-5": "base2-free-fable",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
};

const SERVER_OWNED_METADATA_KEYS = new Set([
  "run_id",
  "runId",
  "client_id",
  "clientId",
  "freebuff_instance_id",
  "freebuffInstanceId",
  "instance_id",
  "instanceId",
  "cost_mode",
  "costMode",
  "agent_id",
  "agentId",
  "ancestorRunIds",
  "totalCredits",
  "directCredits",
  "totalSteps",
  "steps",
  "status",
]);

function generateClientSessionId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 13; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

export function resolveFreebuffModel(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const normalized = model.replace(/^freebuff\//, "").trim();
  return normalized || null;
}

export function resolveFreebuffAgentId(model: string): string | null {
  return MODEL_TO_AGENT[model] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildFreebuffMetadata(params: {
  existing: unknown;
  runId: string;
  instanceId: string;
  clientId?: string;
}): Record<string, unknown> {
  const safeClientMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(asRecord(params.existing))) {
    if (!SERVER_OWNED_METADATA_KEYS.has(key)) {
      safeClientMetadata[key] = value;
    }
  }

  return {
    ...safeClientMetadata,
    run_id: params.runId,
    cost_mode: "free",
    client_id: params.clientId ?? generateClientSessionId(),
    freebuff_instance_id: params.instanceId,
  };
}

export function buildFreebuffChatBody(params: {
  body: unknown;
  model: string;
  stream: boolean;
  runId: string;
  instanceId: string;
}): Record<string, unknown> | null {
  if (!params.body || typeof params.body !== "object" || Array.isArray(params.body)) {
    return null;
  }
  const payload = params.body as Record<string, unknown>;
  return {
    ...payload,
    model: params.model,
    stream: params.stream,
    codebuff_metadata: buildFreebuffMetadata({
      existing: payload.codebuff_metadata,
      runId: params.runId,
      instanceId: params.instanceId,
    }),
  };
}

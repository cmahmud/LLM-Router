export const FREEBUFF_BASE_URL = "https://www.codebuff.com";

export const FREEBUFF_PATHS = {
  admission: "/api/v1/freebuff/session/admission",
  session: "/api/v1/freebuff/session",
  agentRuns: "/api/v1/agent-runs",
  chatCompletions: "/api/v1/chat/completions",
  user: "/api/v1/me?fields=id",
} as const;

export const FREEBUFF_HEADERS = {
  instanceId: "x-freebuff-instance-id",
  model: "x-freebuff-model",
  walletSpendLimit: "x-freebuff-wallet-spend-limit",
  runId: "x-codebuff-run-id",
  agentId: "x-codebuff-agent-id",
} as const;

export const FREEBUFF_OPERATION_TIMEOUT_MS = 20_000;
export const FREEBUFF_MAX_JSON_BYTES = 64 * 1024;

export const FREEBUFF_NON_ACTIVE_ADMISSION_STATUSES = [
  "first_tab_discount_changed",
  "consent_required",
  "none",
  "ended",
  "country_blocked",
  "model_locked",
  "model_unavailable",
  "banned",
  "ip_capped",
  "rate_limited",
  "spend_limited",
  "purchase_claim_released",
  "purchase_in_use",
  "purchase_capacity",
  "premium_slot_taken",
  "superseded",
] as const;

export type FreebuffNonActiveAdmissionStatus =
  (typeof FREEBUFF_NON_ACTIVE_ADMISSION_STATUSES)[number];

export type FreebuffActiveAdmission = {
  status: "active";
  instanceId: string;
  model: string;
  retryAfterMs?: number;
  [key: string]: unknown;
};

export type FreebuffInactiveAdmission = {
  status: FreebuffNonActiveAdmissionStatus;
  retryAfterMs?: number;
  [key: string]: unknown;
};

export type FreebuffAdmission = FreebuffActiveAdmission | FreebuffInactiveAdmission;

export type FreebuffRunStart = {
  runId: string;
  [key: string]: unknown;
};

export type FreebuffUserProbe = {
  id: string;
  [key: string]: unknown;
};

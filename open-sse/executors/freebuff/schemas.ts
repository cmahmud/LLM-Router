import { z } from "zod";

import { FREEBUFF_NON_ACTIVE_ADMISSION_STATUSES } from "./types.ts";

const nonEmptyWireId = z.string().trim().min(1).max(512);

export const freebuffActiveAdmissionSchema = z
  .object({
    status: z.literal("active"),
    instanceId: nonEmptyWireId,
    model: nonEmptyWireId,
    retryAfterMs: z.number().finite().nonnegative().optional(),
  })
  .passthrough();

export const freebuffInactiveAdmissionSchema = z
  .object({
    status: z.enum(FREEBUFF_NON_ACTIVE_ADMISSION_STATUSES),
    retryAfterMs: z.number().finite().nonnegative().optional(),
  })
  .passthrough();

export const freebuffAdmissionSchema = z.union([
  freebuffActiveAdmissionSchema,
  freebuffInactiveAdmissionSchema,
]);

export const freebuffRunStartSchema = z
  .object({
    runId: nonEmptyWireId,
  })
  .passthrough();

export const freebuffUserProbeSchema = z
  .object({
    id: nonEmptyWireId,
  })
  .passthrough();

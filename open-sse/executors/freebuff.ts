import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { FreebuffClient, parseFreebuffRetryAfterMs } from "./freebuff/client.ts";
import {
  FreebuffClientError,
  freebuffErrorResponse,
  freebuffInvalidRequest,
  freebuffUpstreamStatusError,
} from "./freebuff/errors.ts";
import {
  buildFreebuffChatBody,
  resolveFreebuffAgentId,
  resolveFreebuffModel,
} from "./freebuff/request.ts";
import { freebuffCredentialKey, type FreebuffSessionLease } from "./freebuff/sessionManager.ts";
import { getSharedFreebuffRuntime, type FreebuffRequestPermit } from "./freebuff/runtime.ts";
import type { FreebuffRunHandle } from "./freebuff/runManager.ts";

function resolveToken(input: ExecuteInput): string | null {
  const token = input.credentials?.apiKey || input.credentials?.accessToken;
  if (typeof token !== "string" || token.trim().length === 0) return null;
  return token;
}

function unexpectedFreebuffError(operation: string, error: unknown): FreebuffClientError {
  if (error instanceof FreebuffClientError) return error;
  return new FreebuffClientError(`Freebuff ${operation} failed`, {
    status: 502,
    kind: "upstream",
    cause: error,
  });
}

async function releaseLocalResources(
  sessionLease: FreebuffSessionLease | null,
  permit: FreebuffRequestPermit | null
): Promise<void> {
  try {
    await sessionLease?.release();
  } finally {
    permit?.release();
  }
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS.freebuff || { format: "openai" });
  }

  override async execute(input: ExecuteInput) {
    const { body, stream, signal } = input;
    const token = resolveToken(input);
    if (!token) {
      return {
        response: freebuffErrorResponse(
          new FreebuffClientError("Freebuff Auth Token required", {
            status: 401,
            kind: "auth",
          })
        ),
      };
    }

    const requestedModel = resolveFreebuffModel(input.model);
    if (!requestedModel) {
      return {
        response: freebuffInvalidRequest("A Freebuff model is required"),
      };
    }

    const agentId = resolveFreebuffAgentId(requestedModel);
    if (!agentId) {
      return {
        response: freebuffInvalidRequest(`Unsupported Freebuff model: ${requestedModel}`),
      };
    }

    const client = new FreebuffClient();
    const runtime = getSharedFreebuffRuntime();
    let permit: FreebuffRequestPermit | null = null;
    let sessionLease: FreebuffSessionLease | null = null;
    let runHandle: FreebuffRunHandle | null = null;

    try {
      permit = await runtime.scheduler.acquire(freebuffCredentialKey(token), signal);

      sessionLease = await runtime.sessions.acquire({
        client,
        token,
        model: requestedModel,
        signal: permit.signal,
      });

      runHandle = await runtime.runs.start({
        client,
        token,
        agentId,
        signal: permit.signal,
      });

      const upstreamBody = buildFreebuffChatBody({
        body,
        model: requestedModel,
        stream: stream !== false,
        runId: runHandle.runId,
        instanceId: sessionLease.instanceId,
      });

      if (!upstreamBody) {
        await runHandle.finalize("failed");
        await releaseLocalResources(sessionLease, permit);
        sessionLease = null;
        permit = null;
        return {
          response: freebuffInvalidRequest("Freebuff request body must be a JSON object"),
        };
      }

      const response = await client.chatCompletion({
        token,
        agentId,
        runId: runHandle.runId,
        instanceId: sessionLease.instanceId,
        body: upstreamBody,
        signal: permit.signal,
      });

      if (!response.ok) {
        await runHandle.finalize("failed");
        await releaseLocalResources(sessionLease, permit);
        sessionLease = null;
        permit = null;
        return {
          response: freebuffErrorResponse(
            freebuffUpstreamStatusError(
              "chat completion",
              response.status,
              parseFreebuffRetryAfterMs(response.headers.get("retry-after"))
            )
          ),
        };
      }

      const heldLease = sessionLease;
      const heldPermit = permit;
      sessionLease = null;
      permit = null;

      return {
        response: runHandle.bindResponse(response, {
          signal: heldPermit.signal,
          protocol: stream === false ? "json" : "sse",
          onSettled: () => releaseLocalResources(heldLease, heldPermit),
        }),
      };
    } catch (error) {
      const freebuffError = unexpectedFreebuffError("request", error);

      if (runHandle) {
        await runHandle.finalize(freebuffError.kind === "aborted" ? "cancelled" : "failed");
      }
      await releaseLocalResources(sessionLease, permit);

      return {
        response: freebuffErrorResponse(freebuffError),
      };
    }
  }
}

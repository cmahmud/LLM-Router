import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { FreebuffClient, parseFreebuffRetryAfterMs } from "./freebuff/client.ts";
import {
  FreebuffClientError,
  freebuffAdmissionError,
  freebuffErrorResponse,
  freebuffInvalidRequest,
  freebuffUpstreamStatusError,
} from "./freebuff/errors.ts";
import {
  buildFreebuffChatBody,
  resolveFreebuffAgentId,
  resolveFreebuffModel,
} from "./freebuff/request.ts";

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
      return { response: freebuffInvalidRequest("A Freebuff model is required") };
    }

    const agentId = resolveFreebuffAgentId(requestedModel);
    if (!agentId) {
      return {
        response: freebuffInvalidRequest(`Unsupported Freebuff model: ${requestedModel}`),
      };
    }

    const client = new FreebuffClient();
    let runId: string | null = null;

    try {
      const admission = await client.admitSession(token, requestedModel, signal);
      if (admission.status !== "active") {
        return {
          response: freebuffErrorResponse(
            freebuffAdmissionError(admission.status, admission.retryAfterMs)
          ),
        };
      }

      const run = await client.startRun(token, agentId, signal);
      runId = run.runId;

      const upstreamBody = buildFreebuffChatBody({
        body,
        model: requestedModel,
        stream: stream !== false,
        runId,
        instanceId: admission.instanceId,
      });
      if (!upstreamBody) {
        void client.finishRun({ token, runId, status: "failed" }).catch(() => {});
        return { response: freebuffInvalidRequest("Freebuff request body must be a JSON object") };
      }

      const response = await client.chatCompletion({
        token,
        agentId,
        runId,
        instanceId: admission.instanceId,
        body: upstreamBody,
        signal,
      });

      if (!response.ok) {
        void client.finishRun({ token, runId, status: "failed" }).catch(() => {});
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

      // Packet 3 owns response-body/stream lifetime. Until that lands, preserve the
      // existing FINISH timing while making every pre-stream terminal path truthful.
      void client.finishRun({ token, runId, status: "completed" }).catch(() => {});

      return { response };
    } catch (error) {
      const freebuffError = unexpectedFreebuffError("request", error);
      if (runId) {
        const finishStatus = freebuffError.kind === "aborted" ? "cancelled" : "failed";
        void client.finishRun({ token, runId, status: finishStatus }).catch(() => {});
      }
      return { response: freebuffErrorResponse(freebuffError) };
    }
  }
}

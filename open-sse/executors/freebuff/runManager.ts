import type { FreebuffClient } from "./client.ts";
import { wrapFreebuffResponse, type FreebuffResponseProtocol } from "./responseStream.ts";
import type { FreebuffResponseSettlement } from "./responseStream.ts";

export type FreebuffRunClient = Pick<FreebuffClient, "startRun" | "finishRun">;

export type FreebuffRunStatus = "completed" | "failed" | "cancelled";

export type BindFreebuffResponseOptions = {
  signal?: AbortSignal | null;
  protocol?: FreebuffResponseProtocol;
  onSettled?: () => Promise<void> | void;
};

function responseProtocol(response: Response): FreebuffResponseProtocol {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
    ? "sse"
    : "json";
}

function mapSettlement(status: FreebuffResponseSettlement): FreebuffRunStatus {
  return status;
}

export class FreebuffRunHandle {
  readonly runId: string;

  private finalization: Promise<void> | null = null;

  constructor(
    private readonly client: FreebuffRunClient,
    private readonly token: string,
    runId: string
  ) {
    this.runId = runId;
  }

  finalize(status: FreebuffRunStatus): Promise<void> {
    if (this.finalization) return this.finalization;
    this.finalization = this.client
      .finishRun({
        token: this.token,
        runId: this.runId,
        status,
      })
      .catch(() => {});
    return this.finalization;
  }

  bindResponse(response: Response, options: BindFreebuffResponseOptions = {}): Response {
    let settled: Promise<void> | null = null;

    const settle = (status: FreebuffResponseSettlement): Promise<void> => {
      if (settled) return settled;
      settled = (async () => {
        try {
          await this.finalize(mapSettlement(status));
        } finally {
          await options.onSettled?.();
        }
      })();
      return settled;
    };

    return wrapFreebuffResponse(response, {
      protocol: options.protocol ?? responseProtocol(response),
      signal: options.signal,
      onSettled: (status) => settle(status),
    });
  }
}

export class FreebuffRunManager {
  async start(params: {
    client: FreebuffRunClient;
    token: string;
    agentId: string;
    signal?: AbortSignal | null;
  }): Promise<FreebuffRunHandle> {
    const run = await params.client.startRun(params.token, params.agentId, params.signal);
    return new FreebuffRunHandle(params.client, params.token, run.runId);
  }
}

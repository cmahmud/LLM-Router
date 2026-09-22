import type { FreebuffClient } from "./client.ts";

export type FreebuffRunClient = Pick<FreebuffClient, "startRun" | "finishRun">;

export type FreebuffRunStatus = "completed" | "failed" | "cancelled";

export type BindFreebuffResponseOptions = {
  signal?: AbortSignal | null;
  onSettled?: () => Promise<void> | void;
};

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
    const reader = response.body?.getReader();
    let settled: Promise<void> | null = null;
    let controllerClosed = false;
    let abortListener: (() => void) | null = null;

    const settle = (status: FreebuffRunStatus): Promise<void> => {
      if (settled) return settled;
      settled = (async () => {
        try {
          await this.finalize(status);
        } finally {
          try {
            await options.onSettled?.();
          } finally {
            if (abortListener && options.signal) {
              options.signal.removeEventListener("abort", abortListener);
            }
          }
        }
      })();
      return settled;
    };

    if (!reader) {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await settle("completed");
          controller.close();
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (!options.signal) return;
        abortListener = () => {
          const reason =
            options.signal?.reason ?? new DOMException("Freebuff response aborted", "AbortError");
          void reader.cancel(reason).catch(() => {});
          void settle("cancelled").finally(() => {
            if (controllerClosed) return;
            controllerClosed = true;
            try {
              controller.error(reason);
            } catch {}
          });
        };

        if (options.signal.aborted) {
          abortListener();
        } else {
          options.signal.addEventListener("abort", abortListener, {
            once: true,
          });
        }
      },

      async pull(controller) {
        if (settled || controllerClosed) return;
        try {
          const { done, value } = await reader.read();
          if (done) {
            await settle(options.signal?.aborted ? "cancelled" : "completed");
            if (!controllerClosed) {
              controllerClosed = true;
              controller.close();
            }
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          await settle(options.signal?.aborted ? "cancelled" : "failed");
          if (!controllerClosed) {
            controllerClosed = true;
            controller.error(error);
          }
        }
      },

      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await settle("cancelled");
        }
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
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

export type FreebuffResponseProtocol = "sse" | "json";

export type FreebuffResponseSettlement = "completed" | "failed" | "cancelled";

export type FreebuffStreamErrorCode = "malformed" | "upstream_error" | "missing_terminal";

export class FreebuffStreamError extends Error {
  readonly code: FreebuffStreamErrorCode;

  constructor(message: string, code: FreebuffStreamErrorCode) {
    super(message);
    this.name = "FreebuffStreamError";
    this.code = code;
  }
}

export type FreebuffSseParserOptions = {
  maxEventBytes?: number;
};

const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

function streamError(
  message: string,
  code: FreebuffStreamErrorCode = "malformed"
): FreebuffStreamError {
  return new FreebuffStreamError(message, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A bounded SSE observer. It deliberately does not transform or buffer the
 * downstream bytes; it only observes complete events while the response body
 * is pulled by the downstream consumer.
 */
export class FreebuffSseParser {
  private readonly maxEventBytes: number;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private lineBuffer = "";
  private skipLf = false;
  private eventName = "";
  private dataLines: string[] = [];
  private eventBytes = 0;

  terminalSeen = false;

  constructor(options: FreebuffSseParserOptions = {}) {
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  }

  push(bytes: Uint8Array): void {
    let text: string;
    try {
      text = this.decoder.decode(bytes, { stream: true });
    } catch {
      throw streamError("Freebuff stream contained invalid UTF-8");
    }
    this.consumeText(text);
  }

  finish(): void {
    try {
      this.consumeText(this.decoder.decode());
    } catch {
      throw streamError("Freebuff stream contained invalid UTF-8");
    }

    if (this.lineBuffer.length > 0) {
      const finalLine = this.lineBuffer;
      this.lineBuffer = "";
      this.consumeLine(finalLine);
    }
    if (this.dataLines.length > 0) {
      this.dispatchEvent();
    }

    if (!this.terminalSeen) {
      throw streamError("Freebuff stream ended before its terminal event", "missing_terminal");
    }
  }

  private consumeText(text: string): void {
    let start = 0;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];

      if (this.skipLf) {
        this.skipLf = false;
        if (character === "\n") {
          start = index + 1;
          continue;
        }
      }

      if (character === "\n") {
        this.consumeLine(this.lineBuffer + text.slice(start, index));
        this.lineBuffer = "";
        start = index + 1;
      } else if (character === "\r") {
        this.consumeLine(this.lineBuffer + text.slice(start, index));
        this.lineBuffer = "";
        this.skipLf = true;
        start = index + 1;
      }
    }

    this.lineBuffer += text.slice(start);
    this.assertEventBound();
  }

  private consumeLine(line: string): void {
    this.eventBytes += line.length;
    this.assertEventBound();

    if (line === "") {
      this.dispatchEvent();
      return;
    }

    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.dataLines.push(value);
    }
  }

  private dispatchEvent(): void {
    if (this.dataLines.length === 0) {
      this.resetEvent();
      return;
    }

    const data = this.dataLines.join("\n");
    if (data.trim() === "[DONE]") {
      this.terminalSeen = true;
      this.resetEvent();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw streamError("Freebuff stream contained malformed JSON event");
    }

    if (
      this.eventName === "error" ||
      (isRecord(parsed) && ("error" in parsed || parsed.type === "error"))
    ) {
      throw streamError("Freebuff upstream reported a stream error", "upstream_error");
    }

    this.resetEvent();
  }

  private resetEvent(): void {
    this.eventName = "";
    this.dataLines = [];
    this.eventBytes = 0;
  }

  private assertEventBound(): void {
    if (this.eventBytes + this.lineBuffer.length > this.maxEventBytes) {
      throw streamError("Freebuff stream event exceeded the size limit");
    }
  }
}

export type FreebuffResponseStreamOptions = {
  protocol: FreebuffResponseProtocol;
  signal?: AbortSignal | null;
  maxEventBytes?: number;
  maxJsonBytes?: number;
  onSettled?: (status: FreebuffResponseSettlement, error?: unknown) => Promise<void> | void;
};

const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024;

function responseInit(response: Response): ResponseInit {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
}

export function wrapFreebuffResponse(
  response: Response,
  options: FreebuffResponseStreamOptions
): Response {
  const reader = response.body?.getReader();
  const parser =
    options.protocol === "sse"
      ? new FreebuffSseParser({ maxEventBytes: options.maxEventBytes })
      : null;
  const jsonDecoder =
    options.protocol === "json" ? new TextDecoder("utf-8", { fatal: true }) : null;
  const maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  let jsonBytes = 0;
  let jsonText = "";
  let settled: Promise<void> | null = null;
  let controllerClosed = false;
  let cancellationRequested = false;
  let abortListener: (() => void) | null = null;

  const settle = (status: FreebuffResponseSettlement, error?: unknown): Promise<void> => {
    if (settled) return settled;
    settled = Promise.resolve(options.onSettled?.(status, error)).finally(() => {
      if (abortListener && options.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
    });
    return settled;
  };

  const failWithoutBody = new FreebuffStreamError(
    "Freebuff response ended without a body",
    "malformed"
  );

  if (!reader) {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await settle("failed", failWithoutBody);
          controller.error(failWithoutBody);
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(body, responseInit(response));
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!options.signal) return;

      abortListener = () => {
        cancellationRequested = true;
        const reason =
          options.signal?.reason ?? new DOMException("Freebuff response aborted", "AbortError");
        void reader.cancel(reason).catch(() => {});
        void settle("cancelled", reason)
          .catch(() => {})
          .finally(() => {
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
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
    },

    async pull(controller) {
      if (controllerClosed) return;

      try {
        const { done, value } = await reader.read();
        if (done) {
          if (cancellationRequested || options.signal?.aborted) {
            await settle("cancelled");
            const reason =
              options.signal?.reason ?? new DOMException("Freebuff response aborted", "AbortError");
            if (!controllerClosed) {
              controllerClosed = true;
              controller.error(reason);
            }
            return;
          }
          if (parser) {
            parser.finish();
          } else {
            if (!jsonDecoder || jsonBytes === 0) {
              throw failWithoutBody;
            }
            try {
              jsonText += jsonDecoder.decode();
              const parsed = JSON.parse(jsonText) as unknown;
              if (isRecord(parsed) && "error" in parsed) {
                throw streamError("Freebuff upstream reported a response error", "upstream_error");
              }
            } catch (error) {
              if (error instanceof FreebuffStreamError) throw error;
              throw streamError("Freebuff response contained malformed JSON");
            }
          }

          try {
            await settle("completed");
          } catch (error) {
            throw error;
          }
          if (!controllerClosed) {
            controllerClosed = true;
            controller.close();
          }
          return;
        }

        if (options.protocol === "json") {
          jsonBytes += value.byteLength;
          if (jsonBytes > maxJsonBytes) {
            throw streamError("Freebuff response exceeded the size limit");
          }
          try {
            jsonText += jsonDecoder?.decode(value, { stream: true }) ?? "";
          } catch {
            throw streamError("Freebuff response contained invalid UTF-8");
          }
        }

        // Enqueue first so already-produced bytes remain visible to the
        // downstream protocol even when this event later proves malformed.
        controller.enqueue(value);
        if (parser) parser.push(value);
      } catch (error) {
        try {
          await settle(
            cancellationRequested || options.signal?.aborted ? "cancelled" : "failed",
            error
          );
        } catch (settleError) {
          error = settleError;
        }
        if (!controllerClosed) {
          controllerClosed = true;
          controller.error(error);
        }
      }
    },

    async cancel(reason) {
      cancellationRequested = true;
      controllerClosed = true;
      try {
        await reader.cancel(reason);
      } finally {
        try {
          await settle("cancelled", reason);
        } finally {
          if (abortListener && options.signal) {
            options.signal.removeEventListener("abort", abortListener);
          }
        }
      }
    },
  });

  return new Response(body, responseInit(response));
}

// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import {
  parseRpcFrame,
  type RpcErrorDetail,
  type RpcFrame,
  type RpcStreamEvent,
} from "./protocol.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  observationOutcome,
  observeExecution,
  type TraceCarrier,
  traceCarrier,
} from "./observability.ts";

const logger = getSwampLogger(["remote", "rpc"]);

/** A fixed vocabulary, never a caller-controlled method as a metric label. */
function observedRpcOperation(method: string): string {
  return ["capability.queryData", "worker.enroll", "worker.dispatch"].includes(
      method,
    )
    ? method
    : "other";
}

export interface RpcTransport {
  send(data: string): void;
}

export interface RpcHandlerContext {
  requestId: string;
  /** Observational metadata; handlers validate it against dispatch authority. */
  trace?: TraceCarrier;
  responseTrace?: TraceCarrier;
  signal: AbortSignal;
  stream(event: RpcStreamEvent): void;
}

export type RpcHandler = (
  params: unknown,
  ctx: RpcHandlerContext,
) => Promise<unknown>;

export interface RpcCallOptions {
  signal?: AbortSignal;
  /**
   * defaults to DEFAULT_CALL_TIMEOUT_MS; null means no upper bound, since a
   * dispatch runs as long as the method does
   */
  timeoutMs?: number | null;
  onStream?: (event: RpcStreamEvent) => void;
  /**
   * on abort, send rpc.cancel but stay pending until the peer's terminal frame
   * (handler unwound), bounded by CANCEL_GRACE_MS, so a worker reported free
   * really is free
   */
  waitForPeerOnCancel?: boolean;
}

export class RpcError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(detail: RpcErrorDetail) {
    super(detail.message);
    this.name = "RpcError";
    this.code = detail.code;
    this.details = detail.details;
  }
}

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * one byte under the 64 MiB payload Deno's WebSocket receiver rejects with
 * "Frame too large", which closes the whole socket; the receiver offers no
 * setting to raise it
 */
export const MAX_RPC_FRAME_BYTES = 64 * 1024 * 1024 - 1;

export const FRAME_TOO_LARGE = "frame_too_large";

export interface RpcChannelOptions {
  maxFrameBytes?: number;
}

type SendOutcome =
  | { sent: true }
  | { sent: false; tooLargeBytes?: number };

/**
 * after a cooperative cancel, how long to wait for the peer's terminal frame; a
 * handler that ignores its abort signal must not pin the caller forever
 */
export const CANCEL_GRACE_MS = 30_000;

/**
 * rejection for calls pending when the channel closes; the dispatcher uses it
 * to enter grace-window failure semantics
 */
export class ChannelClosedError extends Error {
  constructor(reason?: string) {
    super(reason ?? "RPC channel closed");
    this.name = "ChannelClosedError";
  }
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  onStream?: (event: RpcStreamEvent) => void;
  cleanup: () => void;
}

export class RpcChannel {
  readonly #transport: RpcTransport;
  readonly #handlers = new Map<string, RpcHandler>();
  readonly #pending = new Map<string, PendingCall>();
  readonly #inflight = new Map<string, AbortController>();
  readonly #maxFrameBytes: number;
  #closed = false;

  constructor(transport: RpcTransport, options?: RpcChannelOptions) {
    this.#transport = transport;
    this.#maxFrameBytes = options?.maxFrameBytes ?? MAX_RPC_FRAME_BYTES;
  }

  /** Register the handler for an inbound method. Last registration wins. */
  register(method: string, handler: RpcHandler): void {
    this.#handlers.set(method, handler);
  }

  call<T>(
    method: string,
    params: unknown,
    options?: RpcCallOptions,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("RPC channel is closed"));
    }
    const id = crypto.randomUUID();
    const observation = observeExecution("rpc.client", {
      "swamp.rpc.request_id": id,
      "swamp.rpc.operation": observedRpcOperation(method),
    });
    const timeoutMs = options?.timeoutMs === undefined
      ? DEFAULT_CALL_TIMEOUT_MS
      : options.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelGraceTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        this.#sendFrame({ type: "rpc.cancel", id });
        if (options?.waitForPeerOnCancel) {
          // Stay pending: the peer's terminal frame (or channel close)
          // settles the call once its handler has actually unwound.
          cancelGraceTimer = setTimeout(() => {
            settleReject(
              new DOMException(
                `RPC call '${method}' was aborted, but the peer did not ` +
                  `confirm cancellation within ${CANCEL_GRACE_MS}ms`,
                "AbortError",
              ),
            );
          }, CANCEL_GRACE_MS);
          return;
        }
        settleReject(
          new DOMException("RPC call was aborted", "AbortError"),
        );
      };
      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer);
        }
        options?.signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
      };
      const settleResolve = (result: unknown) => {
        observation.attributes({
          "swamp.rpc.items": Array.isArray(result) ? result.length : 0,
        });
        observation.end("ok");
        cleanup();
        resolve(result as T);
      };
      const settleReject = (error: Error) => {
        const outcome = error instanceof RpcError && error.code === "cancelled"
          ? "cancelled"
          : observationOutcome(error);
        if (outcome === "timeout" || outcome === "cancelled") {
          const now = performance.now();
          for (const [key, entry] of this.#late) {
            if (entry.expires < now) this.#late.delete(key);
          }
          if (this.#late.size >= 1024) {
            this.#late.delete(this.#late.keys().next().value!);
          }
          this.#late.set(id, {
            expires: now + 300_000,
            carrier: observation.carrier,
          });
        }
        observation.end(outcome);
        cleanup();
        reject(error);
      };

      this.#pending.set(id, {
        resolve: settleResolve,
        reject: settleReject,
        onStream: options?.onStream,
        cleanup,
      });

      if (options?.signal) {
        if (options.signal.aborted) {
          // Nothing has been sent yet — no peer work exists to cancel or to
          // wait for, regardless of waitForPeerOnCancel.
          settleReject(
            new DOMException("RPC call was aborted", "AbortError"),
          );
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          this.#sendFrame({ type: "rpc.cancel", id });
          settleReject(
            new DOMException(
              `RPC call '${method}' timed out after ${timeoutMs}ms`,
              "TimeoutError",
            ),
          );
        }, timeoutMs);
      }

      try {
        const outcome = observation.run(() =>
          this.#sendFrame(
            {
              type: "rpc.request",
              id,
              method,
              params,
              ...(observation.carrier ? { trace: observation.carrier } : {}),
            },
            undefined,
            method,
          )
        );
        if (!outcome.sent && outcome.tooLargeBytes !== undefined) {
          settleReject(
            new RpcError({
              code: FRAME_TOO_LARGE,
              message:
                `The request for '${method}' is ${outcome.tooLargeBytes}` +
                ` bytes, over the ${this.#maxFrameBytes} byte control-frame` +
                ` limit; it was not sent`,
            }),
          );
        }
      } catch (error) {
        settleReject(
          error instanceof Error ? error : new Error("RPC send failed"),
        );
      }
    });
  }

  handleRaw(raw: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    return this.handleParsed(parsed);
  }

  handleParsed(parsed: unknown): boolean {
    const frame = parseRpcFrame(parsed);
    if (frame === null) {
      return false;
    }
    if (typeof frame === "string") {
      logger.warn("Dropping malformed RPC frame: {error}", { error: frame });
      return true;
    }
    this.#handleFrame(frame);
    return true;
  }

  close(reason?: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const error = new ChannelClosedError(reason);
    for (const pending of [...this.#pending.values()]) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.#late.clear();
    for (const controller of this.#inflight.values()) {
      controller.abort();
    }
    this.#inflight.clear();
  }

  get closed(): boolean {
    return this.#closed;
  }

  #handleFrame(frame: RpcFrame): void {
    switch (frame.type) {
      case "rpc.request":
        this.#handleRequest(
          frame.id,
          frame.method,
          frame.params,
          traceCarrier(frame.trace),
        );
        break;
      case "rpc.response": {
        const pending = this.#pending.get(frame.id);
        if (!pending) this.#observeLate(frame.id, "ok");
        pending?.resolve(frame.result);
        break;
      }
      case "rpc.error": {
        const pending = this.#pending.get(frame.id);
        if (!pending) this.#observeLate(frame.id, "error");
        pending?.reject(new RpcError(frame.error));
        break;
      }
      case "rpc.stream": {
        const pending = this.#pending.get(frame.id);
        pending?.onStream?.(frame.event);
        break;
      }
      case "rpc.cancel": {
        const controller = this.#inflight.get(frame.id);
        controller?.abort();
        break;
      }
    }
  }

  #handleRequest(
    id: string,
    method: string,
    params: unknown,
    parent?: TraceCarrier,
  ): void {
    if (this.#inflight.has(id)) {
      this.#sendFrame({
        type: "rpc.error",
        id,
        error: {
          code: "duplicate_id",
          message: `Request id '${id}' is already active`,
        },
      });
      return;
    }
    const handler = this.#handlers.get(method);
    if (!handler) {
      this.#sendFrame({
        type: "rpc.error",
        id,
        error: {
          code: "unknown_method",
          message: `No handler registered for method '${method}'`,
        },
      });
      return;
    }

    const controller = new AbortController();
    this.#inflight.set(id, controller);
    const ctx: RpcHandlerContext = {
      requestId: id,
      trace: parent,
      signal: controller.signal,
      stream: (event) => {
        this.#sendFrame({ type: "rpc.stream", id, event }, undefined, method);
      },
    };
    const terminal = (frame: RpcFrame) => {
      const outcome = this.#sendFrame(frame, ctx.responseTrace, method);
      if (outcome.sent || outcome.tooLargeBytes === undefined) return;
      const what = frame.type === "rpc.response" ? "reply" : "error reply";
      this.#sendFrame(
        {
          type: "rpc.error",
          id,
          error: {
            code: FRAME_TOO_LARGE,
            message: `The ${what} to '${method}' is ${outcome.tooLargeBytes}` +
              ` bytes, over the ${this.#maxFrameBytes} byte control-frame` +
              ` limit; the call ran, but its ${what} could not be returned`,
          },
        },
        ctx.responseTrace,
        method,
      );
    };

    // The handler runs detached from the socket's onmessage callback; every
    // outcome (result, thrown error, abort) settles into exactly one
    // terminal frame — cancelled handlers included, so the peer can learn
    // when this side has fully unwound. #sendFrame no-ops after close.
    handler(params, ctx).then(
      (result) => {
        this.#inflight.delete(id);
        terminal({ type: "rpc.response", id, result: result ?? null });
      },
      (error: unknown) => {
        this.#inflight.delete(id);
        if (controller.signal.aborted) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          terminal({
            type: "rpc.error",
            id,
            error: { code: "cancelled", message },
          });
          return;
        }
        if (error instanceof RpcError) {
          terminal({
            type: "rpc.error",
            id,
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const code =
          error instanceof DOMException && error.name === "AbortError"
            ? "cancelled"
            : "handler_failed";
        terminal({ type: "rpc.error", id, error: { code, message } });
      },
    );
  }

  #sendFrame(
    frame: RpcFrame,
    parent?: TraceCarrier,
    method?: string,
  ): SendOutcome {
    if (this.#closed) {
      return { sent: false };
    }
    const observation = observeExecution("rpc.submit", {
      "swamp.rpc.request_id": frame.id,
      "swamp.rpc.frame": frame.type,
      "swamp.transport.delivery": "unknown",
    }, parent);
    try {
      const encoded = JSON.stringify(frame);
      const bytes = new TextEncoder().encode(encoded).byteLength;
      observation.attributes({ "swamp.rpc.encoded_bytes": bytes });
      if (bytes > this.#maxFrameBytes) {
        observation.attributes({ "swamp.rpc.refused": FRAME_TOO_LARGE });
        observation.end("error");
        logger.warn(
          "Refused to send RPC {frameType} for {method} (id {requestId}): {bytes} bytes exceeds the {limit} byte control-frame limit",
          {
            frameType: frame.type,
            method: method ?? "unknown",
            requestId: frame.id,
            bytes,
            limit: this.#maxFrameBytes,
          },
        );
        return { sent: false, tooLargeBytes: bytes };
      }
      this.#transport.send(encoded);
      observation.end("ok");
      return { sent: true };
    } catch (error) {
      observation.end("error");
      logger.warn("Failed to send RPC frame: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { sent: false };
    }
  }

  // Bounded, timer-free retention: expired context is reported as unknown.
  readonly #late = new Map<
    string,
    { expires: number; carrier?: TraceCarrier }
  >();
  #observeLate(id: string, outcome: "ok" | "error"): void {
    const entry = this.#late.get(id);
    this.#late.delete(id);
    const known = entry && entry.expires >= performance.now();
    const observation = observeExecution("rpc.late", {
      "swamp.rpc.request_id": id,
      "swamp.rpc.correlation": known ? "retained" : "unknown",
    }, known ? entry.carrier : undefined);
    observation.end(outcome);
  }
}

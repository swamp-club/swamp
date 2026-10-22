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

/**
 * Symmetric RPC channel over a message transport (see
 * design/enablers/remote-execution.md, "A symmetric control protocol, two handler
 * registries").
 *
 * Both the orchestrator and the worker hold one RpcChannel per control
 * socket. Each side registers handlers for the methods it serves and calls
 * the methods the peer serves — the same framing in both directions. A call
 * may receive streamed events (run events for a dispatch) before its final
 * response.
 */

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

/** Minimal outbound transport: a WebSocket or an in-memory test pipe. */
export interface RpcTransport {
  send(data: string): void;
}

/** Context handed to a registered handler. */
export interface RpcHandlerContext {
  /** The caller-assigned request id for this inbound request. */
  requestId: string;
  /** Observational metadata; handlers validate it against dispatch authority. */
  trace?: TraceCarrier;
  /** Set by an authenticated handler to parent terminal transport submission. */
  responseTrace?: TraceCarrier;
  /** Aborted when the peer cancels the request or the channel closes. */
  signal: AbortSignal;
  /** Emit a stream event for this request before the final response. */
  stream(event: RpcStreamEvent): void;
}

export type RpcHandler = (
  params: unknown,
  ctx: RpcHandlerContext,
) => Promise<unknown>;

export interface RpcCallOptions {
  /** Caller-controlled cancellation; sends rpc.cancel to the peer. */
  signal?: AbortSignal;
  /**
   * Per-call timeout. Defaults to DEFAULT_CALL_TIMEOUT_MS; pass null for
   * calls with no upper bound (a dispatch runs as long as the method does).
   */
  timeoutMs?: number | null;
  /** Receives stream events emitted by the peer's handler. */
  onStream?: (event: RpcStreamEvent) => void;
  /**
   * On signal abort, send rpc.cancel but keep the call pending until the
   * peer's terminal frame arrives (its handler has fully unwound), bounded
   * by CANCEL_GRACE_MS. Without this, abort rejects locally and the peer
   * may still be unwinding — wrong for dispatches, where "the worker is
   * free again" must mean exactly that.
   */
  waitForPeerOnCancel?: boolean;
}

/** Error raised at the caller when the peer answers with rpc.error. */
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
 * After a cooperative cancel (waitForPeerOnCancel), how long to wait for the
 * peer's terminal frame before giving up and rejecting locally — a
 * misbehaving handler that ignores its abort signal must not pin the caller
 * forever.
 */
export const CANCEL_GRACE_MS = 30_000;

/**
 * Rejection raised for calls pending when the channel closes — the signal
 * the dispatcher uses to enter grace-window failure semantics.
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
  #closed = false;

  constructor(transport: RpcTransport) {
    this.#transport = transport;
  }

  /** Register the handler for an inbound method. Last registration wins. */
  register(method: string, handler: RpcHandler): void {
    this.#handlers.set(method, handler);
  }

  /**
   * Call a method on the peer. Resolves with the peer's result, rejects with
   * RpcError (peer-reported), an abort error (cancelled/timeout), or a
   * channel-closed error.
   */
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
        const outcome = observationOutcome(error);
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
        observation.end(observationOutcome(error));
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
        observation.run(() =>
          this.#sendFrame({
            type: "rpc.request",
            id,
            method,
            params,
            ...(observation.carrier ? { trace: observation.carrier } : {}),
          })
        );
      } catch (error) {
        settleReject(
          error instanceof Error ? error : new Error("RPC send failed"),
        );
      }
    });
  }

  /**
   * Feed one raw inbound message. Returns true when the message was an RPC
   * frame (consumed), false when it belongs to another protocol on the same
   * socket.
   */
  handleRaw(raw: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    return this.handleParsed(parsed);
  }

  /** As handleRaw, for callers that already parsed the JSON. */
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

  /**
   * Close the channel: reject every pending outbound call and abort every
   * in-flight inbound handler. Call this from the socket's close handler.
   */
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
        this.#sendFrame({ type: "rpc.stream", id, event });
      },
    };

    // The handler runs detached from the socket's onmessage callback; every
    // outcome (result, thrown error, abort) settles into exactly one
    // terminal frame — cancelled handlers included, so the peer can learn
    // when this side has fully unwound. #sendFrame no-ops after close.
    handler(params, ctx).then(
      (result) => {
        this.#inflight.delete(id);
        this.#sendFrame(
          { type: "rpc.response", id, result: result ?? null },
          ctx.responseTrace,
        );
      },
      (error: unknown) => {
        this.#inflight.delete(id);
        if (controller.signal.aborted) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          this.#sendFrame({
            type: "rpc.error",
            id,
            error: { code: "cancelled", message },
          });
          return;
        }
        if (error instanceof RpcError) {
          this.#sendFrame({
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
        this.#sendFrame({ type: "rpc.error", id, error: { code, message } });
      },
    );
  }

  #sendFrame(frame: RpcFrame, parent?: TraceCarrier): void {
    if (this.#closed) {
      return;
    }
    const observation = observeExecution("rpc.submit", {
      "swamp.rpc.request_id": frame.id,
      "swamp.rpc.frame": frame.type,
      "swamp.transport.delivery": "unknown",
    }, parent);
    try {
      const encoded = JSON.stringify(frame);
      observation.attributes({
        "swamp.rpc.encoded_bytes": new TextEncoder().encode(encoded).byteLength,
      });
      this.#transport.send(encoded);
      observation.end("ok");
    } catch (error) {
      observation.end("error");
      logger.warn("Failed to send RPC frame: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
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

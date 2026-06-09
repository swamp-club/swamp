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
 * design/remote-execution.md, "A symmetric control protocol, two handler
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

const logger = getSwampLogger(["remote", "rpc"]);

/** Minimal outbound transport: a WebSocket or an in-memory test pipe. */
export interface RpcTransport {
  send(data: string): void;
}

/** Context handed to a registered handler. */
export interface RpcHandlerContext {
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
    const timeoutMs = options?.timeoutMs === undefined
      ? DEFAULT_CALL_TIMEOUT_MS
      : options.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        this.#sendFrame({ type: "rpc.cancel", id });
        settleReject(
          new DOMException("RPC call was aborted", "AbortError"),
        );
      };
      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        options?.signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
      };
      const settleResolve = (result: unknown) => {
        cleanup();
        resolve(result as T);
      };
      const settleReject = (error: Error) => {
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
          onAbort();
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

      this.#sendFrame({ type: "rpc.request", id, method, params });
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
        this.#handleRequest(frame.id, frame.method, frame.params);
        break;
      case "rpc.response": {
        const pending = this.#pending.get(frame.id);
        pending?.resolve(frame.result);
        break;
      }
      case "rpc.error": {
        const pending = this.#pending.get(frame.id);
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

  #handleRequest(id: string, method: string, params: unknown): void {
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
      signal: controller.signal,
      stream: (event) => {
        this.#sendFrame({ type: "rpc.stream", id, event });
      },
    };

    // The handler runs detached from the socket's onmessage callback; every
    // outcome (result, thrown error, abort) settles into exactly one frame,
    // so nothing is fire-and-forget.
    handler(params, ctx).then(
      (result) => {
        this.#inflight.delete(id);
        if (!controller.signal.aborted) {
          this.#sendFrame({ type: "rpc.response", id, result: result ?? null });
        }
      },
      (error: unknown) => {
        this.#inflight.delete(id);
        if (controller.signal.aborted) {
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

  #sendFrame(frame: RpcFrame): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#transport.send(JSON.stringify(frame));
    } catch (error) {
      logger.warn("Failed to send RPC frame: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

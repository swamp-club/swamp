// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and\/or modify
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
// along with Swamp.  If not, see <https:\/\/www.gnu.org\/licenses\/>.

import type {
  DataResponse,
  ModelMethodRunEvent,
  ModelMethodRunPayload,
  ModelMethodRunView,
  ServerMessage,
  ServerRequest,
  WorkflowRunEvent,
  WorkflowRunPayload,
  WorkflowRunView,
} from "./protocol.ts";
import {
  type EventHandlers,
  SwampClientError,
  withDefaults,
} from "./stream.ts";

export interface SwampClientOptions {
  token?: string;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  // deno-lint-ignore no-explicit-any
  handlers: EventHandlers<any>;
  // deno-lint-ignore no-explicit-any
  queue?: AsyncIterableQueue<any>;
}

export class SwampClient {
  private url: string;
  private token: string | undefined;
  private socket: WebSocket | null = null;
  // deno-lint-ignore no-explicit-any
  private pending = new Map<string, PendingRequest<any>>();
  private connectPromise: Promise<void> | null = null;

  constructor(url: string, options?: SwampClientOptions) {
    this.url = url;
    this.token = options?.token;
  }

  /**
   * Opens the WebSocket connection. Resolves when the connection is ready.
   * Safe to call multiple times — returns the same promise if already connecting.
   */
  connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const protocols = this.token ? [`bearer.${this.token}`] : undefined;
      const socket = new WebSocket(this.url, protocols);

      socket.onopen = () => {
        this.socket = socket;
        this.connectPromise = null;
        resolve();
      };

      socket.onerror = (event) => {
        this.connectPromise = null;
        const msg = event instanceof ErrorEvent
          ? event.message
          : "WebSocket connection failed";
        reject(new Error(msg));
      };

      socket.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };

      socket.onclose = () => {
        this.socket = null;
        this.connectPromise = null;
        for (const [id, pending] of this.pending) {
          pending.reject(new Error("WebSocket closed"));
          this.pending.delete(id);
        }
      };
    });

    return this.connectPromise;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  async workflowRun(
    payload: WorkflowRunPayload,
    handlers?: Partial<EventHandlers<WorkflowRunEvent>>,
  ): Promise<WorkflowRunView> {
    await this.connect();
    const id = crypto.randomUUID();
    const fullHandlers = handlers
      ? withDefaults<WorkflowRunEvent>(handlers)
      : withDefaults<WorkflowRunEvent>({});

    return new Promise<WorkflowRunView>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, handlers: fullHandlers });
      this.send({
        type: "workflow.run",
        id,
        payload,
      });
    });
  }

  async modelMethodRun(
    payload: ModelMethodRunPayload,
    handlers?: Partial<EventHandlers<ModelMethodRunEvent>>,
  ): Promise<ModelMethodRunView> {
    await this.connect();
    const id = crypto.randomUUID();
    const fullHandlers = handlers
      ? withDefaults<ModelMethodRunEvent>(handlers)
      : withDefaults<ModelMethodRunEvent>({});

    return new Promise<ModelMethodRunView>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, handlers: fullHandlers });
      this.send({
        type: "model.method.run",
        id,
        payload,
      });
    });
  }

  async *workflowRunStream(
    payload: WorkflowRunPayload,
  ): AsyncGenerator<WorkflowRunEvent> {
    await this.connect();
    const id = crypto.randomUUID();
    const queue = new AsyncIterableQueue<WorkflowRunEvent>();

    this.pending.set(id, {
      resolve: () => {},
      reject: (err) => queue.error(err),
      handlers: withDefaults<WorkflowRunEvent>({}, (event) => {
        queue.push(event);
        if (
          event.kind === "completed" || event.kind === "error" ||
          event.kind === "cancelled"
        ) {
          queue.done();
        }
      }),
      queue,
    });

    this.send({ type: "workflow.run", id, payload });

    try {
      yield* queue;
    } finally {
      this.pending.delete(id);
    }
  }

  async *modelMethodRunStream(
    payload: ModelMethodRunPayload,
  ): AsyncGenerator<ModelMethodRunEvent> {
    await this.connect();
    const id = crypto.randomUUID();
    const queue = new AsyncIterableQueue<ModelMethodRunEvent>();

    this.pending.set(id, {
      resolve: () => {},
      reject: (err) => queue.error(err),
      handlers: withDefaults<ModelMethodRunEvent>({}, (event) => {
        queue.push(event);
        if (
          event.kind === "completed" || event.kind === "error" ||
          event.kind === "cancelled"
        ) {
          queue.done();
        }
      }),
      queue,
    });

    this.send({ type: "model.method.run", id, payload });

    try {
      yield* queue;
    } finally {
      this.pending.delete(id);
    }
  }

  cancel(id: string): void {
    this.send({ type: "cancel", id });
  }

  async request<T = DataResponse>(
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    await this.connect();
    const id = crypto.randomUUID();

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        handlers: withDefaults({}),
      });
      const msg: Record<string, unknown> = { type, id };
      if (payload !== undefined) {
        msg.payload = payload;
      }
      this.send(msg as unknown as ServerRequest);
    });
  }

  private handleMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    if (msg.type === "error") {
      const err = new SwampClientError(
        msg.error.code,
        msg.error.message,
        msg.error.details,
      );
      this.pending.delete(msg.id);
      pending.reject(err);
      return;
    }

    if (msg.type === "done") {
      // Authoritative terminal frame (servers >= remote-execution). The
      // event-kind heuristics below remain for older servers that lack it.
      this.pending.delete(msg.id);
      pending.queue?.done();
      return;
    }

    if (msg.type === "event") {
      const event = msg.event;

      const handler = pending.handlers[event.kind];
      if (handler) {
        handler(event);
      }

      if (event.kind === "completed" || event.kind === "cancelled") {
        this.pending.delete(msg.id);
        pending.resolve(event.run);
      } else if (event.kind === "error") {
        this.pending.delete(msg.id);
        // deno-lint-ignore no-explicit-any
        const swampError = event.error as any;
        pending.reject(
          new SwampClientError(
            swampError?.code ?? "unknown",
            swampError?.message ?? "Unknown error",
            swampError?.details,
          ),
        );
      }
      return;
    }

    if ("payload" in msg) {
      this.pending.delete(msg.id);
      // deno-lint-ignore no-explicit-any
      pending.resolve((msg as any).payload);
    }
  }

  private send(request: ServerRequest): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.socket.send(JSON.stringify(request));
  }
}

class AsyncIterableQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | null = null;
  private finished = false;
  private err: Error | null = null;

  push(value: T): void {
    if (this.finished) return;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  done(): void {
    this.finished = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  error(err: Error): void {
    this.err = err;
    this.finished = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.err) return Promise.reject(this.err);
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.finished) {
          return Promise.resolve({
            value: undefined as unknown as T,
            done: true,
          });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolve = resolve;
        });
      },
    };
  }
}

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

/**
 * SwampClient — typed WebSocket client for the swamp serve API.
 *
 * Provides both callback-based and AsyncIterable-based consumption of
 * workflow and model method execution event streams.
 */

import type {
  DataResponse,
  ModelMethodRunEvent,
  ModelMethodRunPayload,
  ModelMethodRunView,
  ServerMessage,
  ServerRequest,
  WorkflowResumePayload,
  WorkflowRunEvent,
  WorkflowRunPayload,
  WorkflowRunResult,
} from "./protocol.ts";
import {
  type EventHandlers,
  SwampClientError,
  withDefaults,
} from "./stream.ts";
import { AsyncIterableQueue } from "./queue.ts";

export interface SwampClientOptions {
  token?: string;
}

// "run" settles into a WorkflowRunResult, "reply" into the event's run or the
// response payload, and "stream" only feeds its queue.
type PendingKind = "run" | "reply" | "stream";

interface PendingRequest {
  kind: PendingKind;
  type: string;
  socket: WebSocket;
  // deno-lint-ignore no-explicit-any
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  // deno-lint-ignore no-explicit-any
  handlers: EventHandlers<any>;
  // deno-lint-ignore no-explicit-any
  queue?: AsyncIterableQueue<any>;
  replayedRunId?: string;
}

type RunTerminal = Extract<
  WorkflowRunEvent,
  { kind: "completed" | "cancelled" | "suspended" }
>;

function runResult(event: RunTerminal): WorkflowRunResult {
  switch (event.kind) {
    case "completed":
      return { ...event.run, outcome: "completed" };
    case "cancelled":
      return {
        ...event.run,
        outcome: "cancelled",
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      };
    case "suspended": {
      const { kind: _kind, run, ...gate } = event;
      return { ...run, outcome: "suspended", gate };
    }
  }
}

export class SwampClient {
  private url: string;
  private token: string | undefined;
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
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

    const promise = new Promise<void>((resolve, reject) => {
      const protocols = this.token ? [`bearer.${this.token}`] : undefined;
      const socket = new WebSocket(this.url, protocols);

      socket.onopen = () => {
        this.socket = socket;
        if (this.connectPromise === promise) this.connectPromise = null;
        resolve();
      };

      socket.onerror = (event) => {
        if (this.connectPromise === promise) this.connectPromise = null;
        const msg = event instanceof ErrorEvent
          ? event.message
          : "WebSocket connection failed";
        reject(new Error(msg));
      };

      socket.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };

      // A socket closed by close() can report it after a reconnect; it settles
      // only the requests sent on it and never touches the newer socket.
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        if (this.connectPromise === promise) this.connectPromise = null;
        for (const [id, pending] of this.pending) {
          if (pending.socket !== socket) continue;
          this.pending.delete(id);
          pending.reject(
            new SwampClientError("connection_closed", "WebSocket closed"),
          );
        }
      };
    });
    this.connectPromise = promise;
    return promise;
  }

  /** Closes the WebSocket connection. */
  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  /**
   * Runs a workflow and settles when serve ends the run's stream: completed,
   * cancelled, suspended at a gate or signal wait, or replayed for a retried
   * `idempotencyKey`. Narrow on `outcome` before reading the run's fields.
   * Optionally dispatches events to partial handlers as they arrive.
   */
  async workflowRun(
    payload: WorkflowRunPayload,
    handlers?: Partial<EventHandlers<WorkflowRunEvent>>,
  ): Promise<WorkflowRunResult> {
    await this.connect();
    return this.runRequest(
      { type: "workflow.run", id: crypto.randomUUID(), payload },
      handlers,
    );
  }

  /**
   * Resumes a suspended workflow run, typically after its gate was approved,
   * and settles like `workflowRun`: at the next gate or when the run ends.
   */
  async workflowResume(
    payload: WorkflowResumePayload,
    handlers?: Partial<EventHandlers<WorkflowRunEvent>>,
  ): Promise<WorkflowRunResult> {
    await this.connect();
    return this.runRequest(
      { type: "workflow.resume", id: crypto.randomUUID(), payload },
      handlers,
    );
  }

  /**
   * Runs a model method and returns the completed event payload.
   * Optionally dispatches events to partial handlers as they arrive.
   */
  async modelMethodRun(
    payload: ModelMethodRunPayload,
    handlers?: Partial<EventHandlers<ModelMethodRunEvent>>,
  ): Promise<ModelMethodRunView> {
    await this.connect();
    const request: ServerRequest = {
      type: "model.method.run",
      id: crypto.randomUUID(),
      payload,
    };
    return new Promise<ModelMethodRunView>((resolve, reject) => {
      this.start(request, {
        kind: "reply",
        resolve,
        reject,
        handlers: withDefaults<ModelMethodRunEvent>(handlers ?? {}),
      });
    });
  }

  /**
   * Returns an AsyncIterable of workflow run events. It ends after a
   * terminal event, `suspended` included, or when serve ends the stream.
   */
  async *workflowRunStream(
    payload: WorkflowRunPayload,
  ): AsyncGenerator<WorkflowRunEvent> {
    await this.connect();
    const id = crypto.randomUUID();
    const queue = new AsyncIterableQueue<WorkflowRunEvent>();

    this.start({ type: "workflow.run", id, payload }, {
      kind: "stream",
      resolve: () => {},
      reject: (err) => queue.error(err),
      handlers: withDefaults<WorkflowRunEvent>({}, (event) => {
        queue.push(event);
        // an error event ends through reject, so the stream throws after it
        if (
          event.kind === "completed" || event.kind === "cancelled" ||
          event.kind === "suspended"
        ) {
          queue.done();
        }
      }),
      queue,
    });

    try {
      yield* queue;
    } finally {
      this.pending.delete(id);
    }
  }

  /**
   * Returns an AsyncIterable of model method run events.
   */
  async *modelMethodRunStream(
    payload: ModelMethodRunPayload,
  ): AsyncGenerator<ModelMethodRunEvent> {
    await this.connect();
    const id = crypto.randomUUID();
    const queue = new AsyncIterableQueue<ModelMethodRunEvent>();

    this.start({ type: "model.method.run", id, payload }, {
      kind: "stream",
      resolve: () => {},
      reject: (err) => queue.error(err),
      handlers: withDefaults<ModelMethodRunEvent>({}, (event) => {
        queue.push(event);
        // an error event ends through reject, so the stream throws after it
        if (event.kind === "completed" || event.kind === "cancelled") {
          queue.done();
        }
      }),
      queue,
    });

    try {
      yield* queue;
    } finally {
      this.pending.delete(id);
    }
  }

  /** Cancels a running operation by its request id. */
  cancel(id: string): void {
    this.send({ type: "cancel", id });
  }

  /**
   * Sends a request-response command and resolves with the response payload.
   * Works with any non-streaming ServerRequest type (data.*, model.*, workflow.search, etc.).
   * A streamed reply resolves with the run of its completed, cancelled or
   * suspended event, so read `status`; `workflowResume` is the typed path.
   */
  async request<T = DataResponse>(
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    await this.connect();
    const id = crypto.randomUUID();
    const msg: Record<string, unknown> = { type, id };
    if (payload !== undefined) {
      msg.payload = payload;
    }

    return new Promise<T>((resolve, reject) => {
      this.start(msg as unknown as ServerRequest, {
        kind: "reply",
        resolve,
        reject,
        handlers: withDefaults({}),
      });
    });
  }

  private runRequest(
    request: ServerRequest,
    handlers: Partial<EventHandlers<WorkflowRunEvent>> | undefined,
  ): Promise<WorkflowRunResult> {
    return new Promise<WorkflowRunResult>((resolve, reject) => {
      this.start(request, {
        kind: "run",
        resolve,
        reject,
        handlers: withDefaults<WorkflowRunEvent>(handlers ?? {}),
      });
    });
  }

  // Registers the request against the socket it is sent on; a send that
  // throws leaves nothing pending.
  private start(
    request: ServerRequest,
    entry: Omit<PendingRequest, "socket" | "type">,
  ): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.pending.set(request.id, { ...entry, type: request.type, socket });
    try {
      socket.send(JSON.stringify(request));
    } catch (error) {
      this.pending.delete(request.id);
      throw error;
    }
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
      if (pending.queue) {
        pending.queue.done();
      } else if (pending.kind === "run" && pending.replayedRunId) {
        pending.resolve({ outcome: "replayed", runId: pending.replayedRunId });
      } else {
        pending.reject(
          new SwampClientError(
            "no_terminal_event",
            `Serve ended the ${pending.type} request without a result`,
          ),
        );
      }
      return;
    }

    if (msg.type === "event") {
      const event = msg.event;

      // Dispatch to handler
      const handler = pending.handlers[event.kind];
      if (handler) {
        handler(event);
      }

      if (
        event.kind === "started" && event.replayed === true &&
        typeof event.runId === "string"
      ) {
        pending.replayedRunId = event.runId;
      }

      // Resolve/reject on terminal events
      if (
        event.kind === "completed" || event.kind === "cancelled" ||
        event.kind === "suspended"
      ) {
        this.pending.delete(msg.id);
        pending.resolve(
          pending.kind === "run" ? runResult(event as RunTerminal) : event.run,
        );
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

    // Request-response: the response type matches the request type and
    // carries a payload (e.g. { type: "workflow.search", id, payload }).
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

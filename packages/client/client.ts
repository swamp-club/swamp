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
  /**
   * how long connecting, and starting a run, keep trying while serve refuses
   * connections or answers that it is starting or draining; defaults to 30 s
   */
  retryBudgetMs?: number;
  /** for tests: waits between attempts */
  sleep?: (ms: number) => Promise<void>;
  /** for tests: the source of jitter, in [0, 1) */
  random?: () => number;
  /** for tests: the clock the retry budget is measured on */
  now?: () => number;
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 5_000;
const RETRY_AFTER_JITTER_CAP_MS = 1_000;

// serve refuses these before it starts the run, so a fresh start is safe
const START_RETRY_CODES = new Set(["draining", "not_ready"]);

// Deno reports a refused connection only as a tcp connect error; a 502-504
// upgrade is a proxy or serve that is restarting
const CONNECT_RETRY_PATTERN =
  /tcp connect error|connection refused|ECONNREFUSED|os error (?:61|111|10061)\b|invalid status code:? 50[234]\b/i;

function backoffMs(attempt: number, random: () => number): number {
  return Math.floor(
    random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt),
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  sawEvent?: boolean;
  /** takes a draining or not_ready refusal that arrives before any event */
  refused?: (error: SwampClientError) => void;
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
  private retired = new Set<WebSocket>();
  private retryBudgetMs: number;
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;
  private now: () => number;

  constructor(url: string, options?: SwampClientOptions) {
    this.url = url;
    this.token = options?.token;
    this.retryBudgetMs = Math.max(0, options?.retryBudgetMs ?? 30_000);
    this.sleep = options?.sleep ?? defaultSleep;
    this.random = options?.random ?? Math.random;
    this.now = options?.now ?? Date.now;
  }

  /**
   * Opens the WebSocket connection. Resolves when the connection is ready.
   * Safe to call multiple times — returns the same promise if already connecting.
   * A refused connection or a 502, 503 or 504 upgrade is tried again with
   * backoff within `retryBudgetMs`.
   */
  connect(): Promise<void> {
    return this.connectBy(this.now() + this.retryBudgetMs);
  }

  // A connect already under way keeps its own deadline.
  private connectBy(deadline: number): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) return this.connectPromise;

    const promise: Promise<void> = this.openWithRetry(deadline).finally(() => {
      if (this.connectPromise === promise) this.connectPromise = null;
    });
    this.connectPromise = promise;
    return promise;
  }

  private async openWithRetry(deadline: number): Promise<void> {
    for (let attempt = 0;; attempt++) {
      try {
        await this.openOnce();
        return;
      } catch (error) {
        if (!CONNECT_RETRY_PATTERN.test((error as Error).message)) throw error;
        const delay = backoffMs(attempt, this.random);
        if (this.now() + delay > deadline) throw error;
        await this.sleep(delay);
      }
    }
  }

  private openOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const protocols = this.token ? [`bearer.${this.token}`] : undefined;
      const socket = new WebSocket(this.url, protocols);

      socket.onopen = () => {
        this.socket = socket;
        resolve();
      };

      socket.onerror = (event) => {
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
        this.retired.delete(socket);
        reject(new Error("WebSocket closed before it opened"));
        for (const [id, pending] of this.pending) {
          if (pending.socket !== socket) continue;
          this.pending.delete(id);
          pending.reject(
            new SwampClientError("connection_closed", "WebSocket closed"),
          );
        }
      };
    });
  }

  /** Closes the WebSocket connection. */
  close(): void {
    this.socket?.close();
    this.socket = null;
    for (const socket of this.retired) socket.close();
    this.retired.clear();
  }

  /**
   * Runs a workflow and settles when serve ends the run's stream: completed,
   * cancelled, suspended at a gate or signal wait, or replayed for a retried
   * `idempotencyKey`. Narrow on `outcome` before reading the run's fields.
   * Optionally dispatches events to partial handlers as they arrive.
   * A start serve refuses as `draining` or `not_ready` is sent again within
   * `retryBudgetMs`; a connection lost after the start rejects with
   * `connection_closed`, since the run may have started.
   */
  workflowRun(
    payload: WorkflowRunPayload,
    handlers?: Partial<EventHandlers<WorkflowRunEvent>>,
  ): Promise<WorkflowRunResult> {
    return this.startWithRetry<WorkflowRunResult>(
      (id) => ({ type: "workflow.run", id, payload }),
      "run",
      withDefaults<WorkflowRunEvent>(handlers ?? {}),
    );
  }

  /**
   * Resumes a suspended workflow run, typically after its gate was approved,
   * and settles like `workflowRun`: at the next gate or when the run ends.
   */
  workflowResume(
    payload: WorkflowResumePayload,
    handlers?: Partial<EventHandlers<WorkflowRunEvent>>,
  ): Promise<WorkflowRunResult> {
    return this.startWithRetry<WorkflowRunResult>(
      (id) => ({ type: "workflow.resume", id, payload }),
      "run",
      withDefaults<WorkflowRunEvent>(handlers ?? {}),
    );
  }

  /**
   * Runs a model method and returns the completed event payload.
   * Optionally dispatches events to partial handlers as they arrive.
   * Retries a refused start like `workflowRun`.
   */
  modelMethodRun(
    payload: ModelMethodRunPayload,
    handlers?: Partial<EventHandlers<ModelMethodRunEvent>>,
  ): Promise<ModelMethodRunView> {
    return this.startWithRetry<ModelMethodRunView>(
      (id) => ({ type: "model.method.run", id, payload }),
      "reply",
      withDefaults<ModelMethodRunEvent>(handlers ?? {}),
    );
  }

  /**
   * Returns an AsyncIterable of workflow run events. It ends after a
   * terminal event, `suspended` included, or when serve ends the stream.
   * Retries a refused start like `workflowRun`.
   */
  workflowRunStream(
    payload: WorkflowRunPayload,
  ): AsyncGenerator<WorkflowRunEvent> {
    return this.streamWithRetry<WorkflowRunEvent>(
      (id) => ({ type: "workflow.run", id, payload }),
      (event) =>
        event.kind === "completed" || event.kind === "cancelled" ||
        event.kind === "suspended",
    );
  }

  /**
   * Returns an AsyncIterable of model method run events.
   * Retries a refused start like `workflowRun`.
   */
  modelMethodRunStream(
    payload: ModelMethodRunPayload,
  ): AsyncGenerator<ModelMethodRunEvent> {
    return this.streamWithRetry<ModelMethodRunEvent>(
      (id) => ({ type: "model.method.run", id, payload }),
      (event) => event.kind === "completed" || event.kind === "cancelled",
    );
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

  private async startWithRetry<T>(
    build: (id: string) => ServerRequest,
    kind: "run" | "reply",
    // deno-lint-ignore no-explicit-any
    handlers: EventHandlers<any>,
  ): Promise<T> {
    const deadline = this.now() + this.retryBudgetMs;
    for (let attempt = 0;; attempt++) {
      await this.connectBy(deadline);
      const outcome = await new Promise<
        { value: T } | { refused: SwampClientError }
      >((resolve, reject) => {
        this.start(build(crypto.randomUUID()), {
          kind,
          resolve: (value: T) => resolve({ value }),
          reject,
          refused: (refused) => resolve({ refused }),
          handlers,
        });
      });
      if ("value" in outcome) return outcome.value;
      await this.waitToRestart(outcome.refused, attempt, deadline);
    }
  }

  private async *streamWithRetry<E extends { kind: string }>(
    build: (id: string) => ServerRequest,
    ends: (event: E) => boolean,
  ): AsyncGenerator<E> {
    const deadline = this.now() + this.retryBudgetMs;
    for (let attempt = 0;; attempt++) {
      await this.connectBy(deadline);
      const id = crypto.randomUUID();
      const queue = new AsyncIterableQueue<E>();
      let refusal: SwampClientError | undefined;

      this.start(build(id), {
        kind: "stream",
        resolve: () => {},
        reject: (err) => queue.error(err),
        refused: (err) => {
          refusal = err;
          queue.done();
        },
        handlers: withDefaults<E>({}, (event) => {
          queue.push(event);
          // an error event ends through reject, so the stream throws after it
          if (ends(event)) queue.done();
        }),
        queue,
      });

      try {
        yield* queue;
      } finally {
        this.pending.delete(id);
      }
      if (refusal === undefined) return;
      await this.waitToRestart(refusal, attempt, deadline);
    }
  }

  // Throws the refusal when the wait would run past the deadline.
  private async waitToRestart(
    refusal: SwampClientError,
    attempt: number,
    deadline: number,
  ): Promise<void> {
    const after = refusal.retryAfterSeconds;
    const delay = after !== undefined
      ? after * 1000 +
        Math.floor(
          this.random() * Math.min(RETRY_AFTER_JITTER_CAP_MS, after * 250),
        )
      : backoffMs(attempt, this.random);
    if (this.now() + delay > deadline) throw refusal;
    await this.sleep(delay);
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
        msg.error.retryAfterSeconds,
      );
      this.pending.delete(msg.id);
      if (
        pending.refused && !pending.sawEvent && START_RETRY_CODES.has(err.code)
      ) {
        if (err.code === "draining") this.retire(pending.socket);
        pending.refused(err);
      } else {
        pending.reject(err);
      }
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
      pending.sawEvent = true;

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
            swampError?.retryAfterSeconds,
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

  // A draining serve takes no new runs on this socket, so the next start
  // opens another; runs already on it finish there.
  private retire(socket: WebSocket): void {
    if (this.socket === socket) this.socket = null;
    for (const pending of this.pending.values()) {
      if (pending.socket === socket) {
        this.retired.add(socket);
        return;
      }
    }
    socket.close();
  }

  private send(request: ServerRequest): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.socket.send(JSON.stringify(request));
  }
}

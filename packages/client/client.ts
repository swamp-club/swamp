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
 * SwampClient — typed WebSocket client for the swamp serve API.
 *
 * Provides both callback-based and AsyncIterable-based consumption of
 * workflow and model method execution event streams.
 */

import type {
  DataResponse,
  DataSubscribeFrame,
  DataSubscribePayload,
  ModelMethodRunEvent,
  ModelMethodRunPayload,
  ModelMethodRunView,
  RunAttachEvent,
  RunAttachKind,
  RunAttachPayload,
  RunEventStamp,
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
import { retryAfterDelayMs } from "./http_transport.ts";

/** Handlers a {@link SwampTransport} calls for one connection. */
export interface SwampTransportHandlers {
  /** A decoded frame from the server. */
  onFrame(frame: ServerMessage): void;
  /** The connection is gone; every request on it is lost. */
  onClose(): void;
}

/** One open channel to serve; requests are tracked against the one they used. */
export interface SwampConnection {
  readonly isOpen: boolean;
  send(request: ServerRequest): void;
  close(): void;
}

/** Lets a {@link SwampClient} run over something other than a socket it owns. */
export interface SwampTransport {
  /** Whether each open gives a new connection, so a draining one can retire. */
  readonly reopens: boolean;
  /** Resolves when frames can be sent; rejects if that cannot happen. */
  open(handlers: SwampTransportHandlers): Promise<SwampConnection>;
}

/** The default transport: a WebSocket to serve per connection. */
export class WebSocketTransport implements SwampTransport {
  readonly reopens = true;
  private url: string;
  private token: string | undefined;

  constructor(url: string, token?: string) {
    this.url = url;
    this.token = token;
  }

  open(handlers: SwampTransportHandlers): Promise<SwampConnection> {
    return new Promise<SwampConnection>((resolve, reject) => {
      const protocols = this.token ? [`bearer.${this.token}`] : undefined;
      const socket = new WebSocket(this.url, protocols);
      let opened = false;
      const connection: SwampConnection = {
        get isOpen() {
          return socket.readyState === WebSocket.OPEN;
        },
        send(request) {
          if (socket.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket is not connected");
          }
          socket.send(JSON.stringify(request));
        },
        close() {
          socket.close();
        },
      };

      socket.onopen = () => {
        opened = true;
        resolve(connection);
      };

      socket.onerror = (event) => {
        const msg = event instanceof ErrorEvent
          ? event.message
          : "WebSocket connection failed";
        reject(new Error(msg));
      };

      socket.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string) as ServerMessage;
        } catch {
          return;
        }
        handlers.onFrame(msg);
      };

      socket.onclose = () => {
        if (!opened) {
          reject(new Error("WebSocket closed before it opened"));
          return;
        }
        handlers.onClose();
      };
    });
  }
}

/** What an attach says besides the run's own events. */
export type RunAttachNotice =
  | {
    kind: "attached";
    runId: string;
    runKind: RunAttachKind;
    startedAt: string;
  }
  | { kind: "elsewhere"; runId: string; instanceId: string }
  | {
    kind: "interrupted";
    runId: string;
    instanceId: string;
    reason: "instance_dead";
  };

/** Everything {@link SwampClient.runAttachStream} yields. */
export type RunFollowEvent = RunAttachEvent | RunAttachNotice;

function attachNotice(msg: ServerMessage): RunAttachNotice | null {
  switch (msg.type) {
    case "run.attached":
      return {
        kind: "attached",
        runId: msg.payload.runId,
        runKind: msg.payload.kind,
        startedAt: msg.payload.startedAt,
      };
    case "run.elsewhere":
      return { kind: "elsewhere", ...msg.payload };
    case "run.interrupted":
      return { kind: "interrupted", ...msg.payload };
    default:
      return null;
  }
}

/** A page {@link SwampClient.dataSubscribeStream} yields. */
export type DataChangesPage = { kind: "changes" } & DataSubscribeFrame;

/** Stops a stream: the run itself goes on, only following it ends. */
export interface StreamOptions {
  signal?: AbortSignal;
}

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

// serve refuses these before it starts the run, so a fresh start is safe
const START_RETRY_CODES = new Set(["draining", "not_ready"]);

// a follower that never reached the leader started nothing; one marked
// inFlight may have, so it is never sent again
function refusedBeforeStart(err: SwampClientError): boolean {
  if (START_RETRY_CODES.has(err.code)) return true;
  if (err.code !== "serve_not_leader") return false;
  const details = err.details as { inFlight?: unknown } | undefined;
  return details?.inFlight !== true;
}

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
  connection: SwampConnection;
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
  private transport: SwampTransport;
  private connection: SwampConnection | null = null;
  private pending = new Map<string, PendingRequest>();
  private connectPromise: Promise<void> | null = null;
  private retired = new Set<SwampConnection>();
  private retryBudgetMs: number;
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;
  private now: () => number;

  constructor(target: string | SwampTransport, options?: SwampClientOptions) {
    this.transport = typeof target === "string"
      ? new WebSocketTransport(target, options?.token)
      : target;
    this.retryBudgetMs = Math.max(0, options?.retryBudgetMs ?? 30_000);
    this.sleep = options?.sleep ?? defaultSleep;
    this.random = options?.random ?? Math.random;
    this.now = options?.now ?? Date.now;
  }

  /**
   * Opens the connection. Resolves when the connection is ready.
   * Safe to call multiple times — returns the same promise if already connecting.
   * A refused connection or a 502, 503 or 504 upgrade is tried again with
   * backoff within `retryBudgetMs`.
   */
  connect(): Promise<void> {
    return this.connectBy(this.now() + this.retryBudgetMs);
  }

  // A connect already under way keeps its own deadline.
  private connectBy(deadline: number): Promise<void> {
    if (this.connection?.isOpen) return Promise.resolve();
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

  private async openOnce(): Promise<void> {
    let connection: SwampConnection | null = null;
    // A connection closed by close() can report it after a reconnect; it
    // settles only the requests sent on it and never touches the newer one.
    connection = await this.transport.open({
      onFrame: (frame) => this.handleMessage(frame),
      onClose: () => {
        if (connection === null) return;
        if (this.connection === connection) this.connection = null;
        this.retired.delete(connection);
        for (const [id, pending] of this.pending) {
          if (pending.connection !== connection) continue;
          this.pending.delete(id);
          pending.reject(
            new SwampClientError("connection_closed", "WebSocket closed"),
          );
        }
      },
    });
    this.connection = connection;
  }

  /** Closes the connection. */
  close(): void {
    this.connection?.close();
    this.connection = null;
    for (const connection of this.retired) connection.close();
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
    options: StreamOptions = {},
  ): AsyncGenerator<WorkflowRunEvent & RunEventStamp> {
    return this.streamWithRetry<WorkflowRunEvent & RunEventStamp>(
      (id) => ({ type: "workflow.run", id, payload }),
      (event) =>
        event.kind === "completed" || event.kind === "cancelled" ||
        event.kind === "suspended",
      options.signal,
    );
  }

  /**
   * Returns an AsyncIterable of model method run events.
   * Retries a refused start like `workflowRun`.
   */
  modelMethodRunStream(
    payload: ModelMethodRunPayload,
    options: StreamOptions = {},
  ): AsyncGenerator<ModelMethodRunEvent> {
    return this.streamWithRetry<ModelMethodRunEvent>(
      (id) => ({ type: "model.method.run", id, payload }),
      (event) => event.kind === "completed" || event.kind === "cancelled",
      options.signal,
    );
  }

  /** Yields `attached` first; `elsewhere` or `interrupted` ends the stream. */
  runAttachStream(
    payload: RunAttachPayload,
    options: StreamOptions = {},
  ): AsyncGenerator<RunFollowEvent> {
    return this.streamWithRetry<RunFollowEvent>(
      (id) => ({ type: "run.attach", id, payload }),
      (event) =>
        event.kind === "completed" || event.kind === "cancelled" ||
        event.kind === "suspended" || event.kind === "elsewhere" ||
        event.kind === "interrupted",
      options.signal,
    );
  }

  /** Runs until stopped; throws a resumable error to resubscribe from the last cursor. */
  dataSubscribeStream(
    payload: DataSubscribePayload,
    options: StreamOptions = {},
  ): AsyncGenerator<DataChangesPage> {
    return this.streamWithRetry<DataChangesPage>(
      (id) => ({ type: "data.subscribe", id, payload }),
      () => false,
      options.signal,
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
    signal?: AbortSignal,
  ): AsyncGenerator<E> {
    if (signal?.aborted) return;
    const deadline = this.now() + this.retryBudgetMs;
    for (let attempt = 0;; attempt++) {
      await this.connectBy(deadline);
      const id = crypto.randomUUID();
      const queue = new AsyncIterableQueue<E>();
      let refusal: SwampClientError | undefined;
      let ended = false;

      this.start(build(id), {
        kind: "stream",
        resolve: () => {
          ended = true;
        },
        reject: (err) => {
          ended = true;
          queue.error(err);
        },
        refused: (err) => {
          ended = true;
          refusal = err;
          queue.done();
        },
        handlers: withDefaults<E>({}, (event) => {
          queue.push(event);
          // an error event ends through reject, so the stream throws after it
          if (ends(event)) {
            ended = true;
            queue.done();
          }
        }),
        queue,
      });
      const onAbort = () => queue.done();
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        yield* queue;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        // a consumer that stops early detaches; serve keeps the run going
        if (!ended && this.pending.has(id)) {
          try {
            this.cancel(id);
          } catch {
            // The connection is gone, and with it the stream.
          }
        }
        this.settle(id);
      }
      if (refusal === undefined || signal?.aborted) return;
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
    // a Retry-After of 0 would resend with no pause at all
    const delay = after !== undefined
      ? Math.max(BACKOFF_BASE_MS, retryAfterDelayMs(after, this.random))
      : backoffMs(attempt, this.random);
    if (this.now() + delay > deadline) throw refusal;
    await this.sleep(delay);
  }

  // Registers the request against the connection it is sent on; a send that
  // throws leaves nothing pending.
  private start(
    request: ServerRequest,
    entry: Omit<PendingRequest, "connection" | "type">,
  ): void {
    const connection = this.connection;
    if (!connection || !connection.isOpen) {
      throw new Error("WebSocket is not connected");
    }
    this.pending.set(request.id, { ...entry, type: request.type, connection });
    try {
      connection.send(request);
    } catch (error) {
      this.pending.delete(request.id);
      throw error;
    }
  }

  private handleMessage(msg: ServerMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;

    if (msg.type === "error") {
      const err = new SwampClientError(
        msg.error.code,
        msg.error.message,
        msg.error.details,
        msg.error.retryAfterSeconds,
      );
      this.settle(msg.id);
      if (
        pending.refused && !pending.sawEvent && refusedBeforeStart(err)
      ) {
        // a fresh connection may reach a node that can start it
        if (
          (err.code === "draining" || err.code === "serve_not_leader") &&
          this.transport.reopens
        ) {
          this.retire(pending.connection);
        }
        pending.refused(err);
      } else {
        pending.reject(err);
      }
      return;
    }

    if (msg.type === "done") {
      // Authoritative terminal frame (servers >= remote-execution). The
      // event-kind heuristics below remain for older servers that lack it.
      this.settle(msg.id);
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
        this.settle(msg.id);
        pending.resolve(
          pending.kind === "run" ? runResult(event as RunTerminal) : event.run,
        );
      } else if (event.kind === "error") {
        this.settle(msg.id);
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

    // a subscription's pages carry payloads but belong in its stream
    if (pending.queue && msg.type === "data.subscribe") {
      pending.sawEvent = true;
      pending.handlers["changes"]?.({ kind: "changes", ...msg.payload });
      return;
    }

    // an attach's frames carry payloads but belong in its stream
    const notice = pending.queue ? attachNotice(msg) : null;
    if (notice !== null) {
      pending.sawEvent = true;
      pending.handlers[notice.kind]?.(notice);
      return;
    }

    // Request-response: the response type matches the request type and
    // carries a payload (e.g. { type: "workflow.search", id, payload }).
    if ("payload" in msg) {
      this.settle(msg.id);
      // deno-lint-ignore no-explicit-any
      pending.resolve((msg as any).payload);
    }
  }

  // a retired connection closes once the last request on it settles
  private settle(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const connection = pending.connection;
    if (!this.retired.has(connection)) return;
    for (const other of this.pending.values()) {
      if (other.connection === connection) return;
    }
    this.retired.delete(connection);
    connection.close();
  }

  // A draining serve takes no new runs on this connection, so the next start
  // opens another; runs already on it finish there.
  private retire(connection: SwampConnection): void {
    if (this.connection === connection) this.connection = null;
    for (const pending of this.pending.values()) {
      if (pending.connection === connection) {
        this.retired.add(connection);
        return;
      }
    }
    connection.close();
  }

  private send(request: ServerRequest): void {
    if (!this.connection || !this.connection.isOpen) {
      throw new Error("WebSocket is not connected");
    }
    this.connection.send(request);
  }
}

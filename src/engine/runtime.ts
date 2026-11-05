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

import type { Principal } from "../domain/access/principal.ts";
import { parsePrincipal } from "../domain/access/principal.ts";
import { handleMessage, validateServerRequest } from "../serve/connection.ts";
import {
  type ConnectionContext,
  removeConnection,
  setConnectionCollectives,
  setConnectionLoginIdentity,
  setConnectionSourceIp,
  setConnectionTeardown,
  setConnectionToken,
} from "../serve/handlers/shared.ts";
import type { SessionReply } from "../serve/session.ts";
import { HTTP_REQUEST_TYPES, type ServerMessage } from "../serve/protocol.ts";
import {
  type CallerClass,
  CallerClassPolicy,
  isCallerClass,
  pageRefusal,
} from "../serve/caller_class.ts";
import {
  FORWARDED_READS,
  isDelegatedAction,
} from "../serve/local/local_actions.ts";
import {
  type ActionRunner,
  runDelegatedAction,
  SWAMP_CLI_ACTIONS,
} from "../serve/local/delegated_actions.ts";
import {
  authenticateServerToken,
  type ServerTokenAuthDeps,
} from "../serve/token_auth.ts";
import {
  ENGINE_PROTOCOL,
  type EngineRequest,
  EngineWriter,
  parseEngineRequest,
  readEngineFrames,
} from "./protocol.ts";
import { validateEngineMethodRun } from "./profile.ts";

interface Session {
  readonly reply: SessionReply;
  readonly callerClass: CallerClass;
  readonly ctx: ConnectionContext;
  readonly principal: Principal | null;
  readonly requests: Map<string, AbortController>;
  readonly timer?: ReturnType<typeof setTimeout>;
  /** page reads this session dispatched: the only ids its cancel may name */
  readonly forwarded: Set<string>;
  /** closes once its single request settles, as an HTTP reply stream does */
  readonly oneShot: boolean;
  dispatched: boolean;
}
export type EngineMode = "full" | "read-only";
interface OpeningSession {
  cancelled: boolean;
  readonly controller: AbortController;
}
export interface EngineRuntimeOptions {
  /** cli sessions use this context; in read-only mode it is the page context */
  context: ConnectionContext;
  /** dashboard tabs share every service but run with auth mode none */
  page?: {
    context: ConnectionContext;
    actions?: ActionRunner;
  };
  /** read-only engines admit page sessions only */
  mode?: EngineMode;
  readOnlyReason?: string;
  /** false when an untrusted workspace's engine loaded no extension code */
  extensions?: boolean;
  health?: (signal: AbortSignal) => Promise<unknown>;
  engineVersion: string;
  gitSha: string;
  /** AsyncIterable inputs share this controller with their framed reader. */
  inputCancellation?: AbortController;
  /** Injectable deadline scheduling for deterministic lifecycle tests. */
  scheduleDeadline?: (delayMs: number, expired: () => void) => () => void;
  /** Monotonic milliseconds for allocating the remaining shutdown budget. */
  now?: () => number;
  /** Authentication ports may be supplied by a local composition. */
  authenticationDeps?: ServerTokenAuthDeps;
  /** Authentication deadlines are independent of lifecycle drain deadlines. */
  scheduleAuthenticationDeadline?: (
    delayMs: number,
    expired: () => void,
  ) => () => void;
  /** Flush and dispose all repositories/background services after work settles. */
  dispose(): Promise<void>;
}

/** Owns only transport sessions; execution lifetime stays in the shared registry. */
export class EngineRuntime {
  readonly #options: EngineRuntimeOptions;
  readonly #writer: EngineWriter;
  readonly #sessions = new Map<string, Session>();
  readonly #openingSessions = new Map<string, OpeningSession>();
  readonly #authenticationTasks = new Set<Promise<void>>();
  // A timeout cancels its waiter, never forgets the underlying provider. A
  // retiring generation admits no replacement authentication, keeping this
  // bounded even when a legacy provider ignores cancellation forever.
  readonly #authenticationWork = new Set<Promise<unknown>>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #cliPolicy = CallerClassPolicy.cli(ENGINE_PROTOCOL.operations);
  readonly #pagePolicy = CallerClassPolicy.page();
  // Stopping kills attached delegated commands and ends a resume's wait.
  readonly #actionsStopped = new AbortController();
  #generation: string | undefined;
  #state = "starting";
  readonly #inputCancellation: AbortController;
  #disposal: Promise<void> | undefined;
  #shutdown: Promise<void> | undefined;
  #transportFailed = false;
  constructor(
    options: EngineRuntimeOptions,
    output: WritableStream<Uint8Array>,
  ) {
    this.#options = options;
    this.#inputCancellation = options.inputCancellation ??
      new AbortController();
    this.#writer = new EngineWriter(output, () => this.#failTransport());
    if (options.mode === "read-only" && !options.page) {
      throw new Error("A read-only engine serves page sessions only");
    }
  }
  get #callerClasses(): CallerClass[] {
    if (!this.#options.page) return ["cli"];
    return this.#options.mode === "read-only" ? ["page"] : ["cli", "page"];
  }
  get status() {
    return {
      state: this.#state,
      sessions: this.#sessions.size,
      requests: this.#tasks.size + this.#authenticationTasks.size,
      authenticationWork: this.#authenticationWork.size,
      runs: this.#options.context.activeRunRegistry?.size ?? 0,
      reservations: this.#options.context.activeRunRegistry?.reservedCount ?? 0,
      pendingWrites: this.#writer.pending,
    };
  }
  async serve(
    input: ReadableStream<Uint8Array> | AsyncIterable<unknown>,
  ): Promise<void> {
    try {
      if (
        !(input instanceof ReadableStream) && !this.#options.inputCancellation
      ) {
        throw new Error(
          "Async engine input requires its reader cancellation controller",
        );
      }
      const frames = input instanceof ReadableStream
        ? readEngineFrames(input, undefined, this.#inputCancellation.signal)
        : input;
      for await (const frame of frames) {
        const request = parseEngineRequest(frame);
        await this.#control(request);
        await this.#writer.flush();
        if (this.#transportFailed) throw new Error("Engine output unavailable");
        if (this.#state === "stopped") break;
      }
    } finally {
      try {
        await this.shutdown(30_000);
      } finally {
        await this.#writer.close(this.#state !== "failed");
      }
    }
  }
  async #control(request: EngineRequest): Promise<void> {
    if (this.#generation === undefined) {
      if (
        request.method !== "hello" ||
        request.params?.profile !== ENGINE_PROTOCOL.profile
      ) {
        throw new Error("Engine hello required for local-v1");
      }
      this.#generation = request.generation;
    }
    if (request.generation !== this.#generation) {
      throw new Error("Engine generation mismatch");
    }
    const base = {
      version: ENGINE_PROTOCOL.version,
      generation: this.#generation,
      id: request.id,
    };
    const response = this.#respond(request, base);
    if (request.method === "health.snapshot") {
      // Collection reads the datastore; established sessions keep the loop.
      const tracked = response.catch(() => this.#failTransport()).finally(() =>
        this.#tasks.delete(tracked)
      );
      this.#tasks.add(tracked);
      return;
    }
    if (request.method === "session.open") {
      // Vault providers may be slow. Authentication has bounded reservations
      // but never owns the control loop used by established sessions.
      const tracked = response.catch(() => this.#failTransport()).finally(() =>
        this.#authenticationTasks.delete(tracked)
      );
      this.#authenticationTasks.add(tracked);
      return;
    }
    await response;
  }
  async #respond(
    request: EngineRequest,
    base: { version: number; generation: string; id: string },
  ): Promise<void> {
    try {
      const result = await this.#dispatch(request);
      this.#writer.send({ ...base, result });
    } catch (error) {
      // Only our enumerated control errors cross this boundary; never raw provider errors.
      const code = error instanceof ControlError ? error.code : "engine_error";
      const message = error instanceof ControlError
        ? error.message
        : "Engine control failed";
      this.#writer.send({ ...base, error: { code, message } });
    }
  }
  async #dispatch(request: EngineRequest): Promise<unknown> {
    const params = request.params ?? {};
    switch (request.method) {
      case "hello":
        if (this.#state !== "starting") {
          throw new ControlError("invalid_state", "Engine already initialized");
        }
        this.#state = "ready";
        return {
          profile: ENGINE_PROTOCOL.profile,
          version: ENGINE_PROTOCOL.version,
          operations: ENGINE_PROTOCOL.operations,
          callerSessionIds: true,
          authenticationDeadlines: true,
          engineVersion: this.#options.engineVersion,
          gitSha: this.#options.gitSha,
          // A hub verifies it reached the repository it selected.
          repo: { path: this.#options.context.repoDir },
          callerClasses: this.#callerClasses,
          mode: this.#options.mode ?? "full",
          extensions: this.#options.extensions ?? true,
        };
      case "session.open":
        this.#admit();
        return await this.#open(params);
      case "session.close":
        this.#close(textParam(params, "sessionId"));
        return {};
      case "request.dispatch": {
        const id = textParam(params, "sessionId");
        const session = this.#sessions.get(id);
        if (!session) {
          throw new ControlError(
            "unknown_session",
            "Reauthenticate the session",
          );
        }
        const publicRequest = params.request;
        if (
          !publicRequest || typeof publicRequest !== "object" ||
          Array.isArray(publicRequest)
        ) {
          throw new ControlError(
            "invalid_request",
            "Expected public request envelope",
          );
        }
        const value = publicRequest as Record<string, unknown>;
        this.#admit(String(value.type));
        const publicId = typeof value.id === "string" && value.id.length <= 256
          ? value.id
          : "unknown";
        if (session.oneShot) {
          if (session.dispatched) {
            throw new ControlError(
              "invalid_request",
              "A one-shot session takes one request",
            );
          }
          session.dispatched = true;
        }
        if (session.callerClass === "page") {
          return this.#dispatchPage(session, value, publicId, params.http);
        }
        if (!this.#cliPolicy.allows(String(value.type))) {
          session.reply.send({
            type: "error",
            id: publicId,
            error: {
              code: "unsupported_operation",
              message: "Operation is not available in local-v1",
            },
          });
          return {};
        }
        if (value.type === "model.method.run") {
          try {
            validateEngineMethodRun(
              value.payload as Parameters<typeof validateEngineMethodRun>[0],
            );
          } catch {
            session.reply.send({
              type: "error",
              id: publicId,
              error: {
                code: "unsupported_operation",
                message: "local-v1 runs existing behavior definitions only",
              },
            });
            return {};
          }
        }
        this.#handle(session, value, publicId);
        return {};
      }
      case "health.snapshot": {
        const health = this.#options.health;
        if (!health) {
          throw new ControlError(
            "unsupported_operation",
            "Unknown engine control operation",
          );
        }
        this.#admit();
        return await health(AbortSignal.timeout(30_000));
      }
      case "engine.status":
        return this.status;
      case "engine.quiesce": {
        const retiring = this.#state === "retiring";
        if (this.#state !== "ready" && !retiring) return { quiescent: false };
        const s = this.status;
        if (
          (!retiring && s.sessions) || s.requests || s.runs || s.reservations
        ) {
          return { quiescent: false };
        }
        const deadlineMs = deadlineParam(params);
        // Pending authentication is counted above. Publication also rechecks
        // ready state, so no asynchronous opener can cross this freeze.
        this.#state = "quiescing";
        // Timed-out authentication is read-only and remains quarantined until
        // process exit. Accepted work and its observers have settled first.
        for (const id of [...this.#sessions.keys()]) this.#close(id);
        // Retain this outcome so serve's finalizer cannot restart a fresh
        // shutdown budget after quiescence has already timed out.
        this.#shutdown = this.#quiesce(deadlineMs);
        await this.#shutdown;
        return { quiescent: true };
      }
      case "engine.shutdown":
        await this.shutdown(deadlineParam(params));
        return {};
      default:
        throw new ControlError(
          "unsupported_operation",
          "Unknown engine control operation",
        );
    }
  }
  #handle(
    session: Session,
    value: Record<string, unknown>,
    publicId: string,
  ): void {
    if (value.type !== "cancel" && this.#tasks.size >= 128) {
      throw new ControlError(
        "too_many_requests",
        "Engine request limit reached",
      );
    }
    this.#track(
      session,
      publicId,
      (async () =>
        await handleMessage(
          session.reply,
          session.ctx,
          session.requests,
          new MessageEvent("message", { data: JSON.stringify(value) }),
          session.principal,
        ))(),
    );
  }
  #track(session: Session, publicId: string, task: Promise<unknown>): void {
    const tracked = task.then(() => {}, () => {
      if (session.reply.open) {
        session.reply.send({
          type: "error",
          id: publicId,
          error: { code: "engine_error", message: "Engine request failed" },
        });
      }
    }).finally(() => {
      this.#tasks.delete(tracked);
      if (session.oneShot) session.reply.close(1000, "Request complete");
    });
    this.#tasks.add(tracked);
  }
  /** what a dashboard tab sends: its reads, its four actions and cancel */
  #dispatchPage(
    session: Session,
    value: Record<string, unknown>,
    publicId: string,
    http: unknown,
  ): Record<string, never> {
    const type = String(value.type);
    if (http === true) {
      if (!session.oneShot) {
        throw new ControlError(
          "invalid_request",
          "HTTP requests need a one-shot session",
        );
      }
      // The same refusals, in the same order, as the hub and its child.
      if (!FORWARDED_READS.has(type)) {
        throw new ControlError(
          "use_websocket",
          `'${type}' is not answered over HTTP here; send it over the WebSocket`,
        );
      }
      const validated = validateServerRequest(value);
      if (typeof validated === "string") {
        throw new ControlError("invalid_request", validated);
      }
      if (!HTTP_REQUEST_TYPES.has(type)) {
        throw new ControlError(
          "use_websocket",
          `'${type}' is not answered over HTTP; send it over the WebSocket`,
        );
      }
    }
    if (type === "cancel") {
      // A cancel for anything else is the page detaching from an action.
      if (session.forwarded.has(publicId)) {
        this.#handle(session, value, publicId);
      } else if (session.oneShot) {
        session.reply.close(1000, "Request complete");
      }
      return {};
    }
    if (isDelegatedAction(type)) {
      if (this.#tasks.size >= 128) {
        throw new ControlError(
          "too_many_requests",
          "Engine request limit reached",
        );
      }
      const page = this.#options.page!;
      const reply = (frame: unknown) => {
        if (session.reply.open) session.reply.send(frame as ServerMessage);
      };
      this.#track(
        session,
        publicId,
        runDelegatedAction(
          {
            repoDir: session.ctx.repoDir,
            actions: page.actions ?? SWAMP_CLI_ACTIONS,
            signal: this.#actionsStopped.signal,
          },
          type,
          publicId,
          value.payload,
          reply,
        ).then(({ exited }) => {
          // The run is the resume's own: never awaited, `done` only if it
          // ends while this page still listens.
          exited?.then(() => reply({ type: "done", id: publicId }))
            .catch(() => {});
        }),
      );
      return {};
    }
    if (!this.#pagePolicy.allows(type)) {
      session.reply.send(pageRefusal(publicId, type) as ServerMessage);
      if (session.oneShot) session.reply.close(1000, "Request complete");
      return {};
    }
    session.forwarded.add(publicId);
    this.#handle(session, value, publicId);
    return {};
  }
  #admit(operation?: string): void {
    if (this.#state === "retiring") {
      if (
        operation !== undefined && operation !== "workflow.run" &&
        operation !== "model.method.run"
      ) return;
      throw new ControlError(
        "engine_retiring",
        "Authentication recovery is waiting for accepted work to finish; retry after engine retirement",
      );
    }
    if (this.#state !== "ready") {
      throw new ControlError("draining", "Engine is not accepting work");
    }
  }
  async #open(params: Record<string, unknown>): Promise<{ sessionId: string }> {
    if (
      this.#sessions.size + this.#openingSessions.size >=
        ENGINE_PROTOCOL.limits.sessions
    ) {
      throw new ControlError(
        "too_many_sessions",
        "Engine session limit reached",
      );
    }
    if (
      this.#authenticationWork.size >=
        ENGINE_PROTOCOL.limits.engineAuthentications
    ) {
      throw new ControlError(
        "too_many_authentications",
        "Engine authentication limit reached",
      );
    }
    // The supervisor chooses the ID before sending an open, so a timeout can
    // close a pending authentication as well as a fully published session.
    const sessionId = params.sessionId === undefined
      ? crypto.randomUUID()
      : textParam(params, "sessionId");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new ControlError("invalid_request", "Invalid session ID");
    }
    if (this.#sessions.has(sessionId) || this.#openingSessions.has(sessionId)) {
      throw new ControlError(
        "duplicate_session",
        "Session ID is already in use",
      );
    }
    const callerClass = params.class ?? "cli";
    if (!isCallerClass(callerClass)) {
      throw new ControlError("invalid_request", "Invalid caller class");
    }
    if (!this.#callerClasses.includes(callerClass)) {
      throw new ControlError(
        "unsupported_profile",
        callerClass === "cli"
          ? this.#options.readOnlyReason ??
            "This workspace is served read-only to the dashboard; the CLI cannot use it through this engine"
          : "This engine serves no dashboard sessions",
      );
    }
    const oneShot = params.oneShot ?? false;
    if (typeof oneShot !== "boolean") {
      throw new ControlError("invalid_request", "Invalid one-shot flag");
    }
    const sourceIp = textParam(params, "sourceIp");
    if (callerClass === "page") {
      // The hub checked a page lease; a page carries no credential here.
      if (this.#state !== "ready") {
        throw new ControlError("draining", "Engine is not accepting work");
      }
      const reply = this.#publish(sessionId, {
        callerClass,
        ctx: this.#options.page!.context,
        principal: null,
        oneShot,
      });
      setConnectionSourceIp(reply, sourceIp);
      setConnectionTeardown(reply, () => this.#detach(sessionId));
      return { sessionId };
    }
    if (oneShot) {
      throw new ControlError(
        "invalid_request",
        "One-shot sessions are for page requests",
      );
    }
    const credential = textParam(params, "credential");
    const authenticationTimeoutMs = params.authenticationTimeoutMs ?? 10_000;
    if (
      typeof authenticationTimeoutMs !== "number" ||
      !Number.isFinite(authenticationTimeoutMs) ||
      authenticationTimeoutMs <= 0 ||
      authenticationTimeoutMs > 300_000
    ) {
      throw new ControlError(
        "invalid_request",
        "Invalid authentication deadline",
      );
    }
    const opening: OpeningSession = {
      cancelled: false,
      controller: new AbortController(),
    };
    this.#openingSessions.set(sessionId, opening);
    try {
      return await this.#authenticate(
        sessionId,
        opening,
        credential,
        sourceIp,
        authenticationTimeoutMs,
      );
    } finally {
      this.#openingSessions.delete(sessionId);
    }
  }
  async #authenticate(
    sessionId: string,
    opening: OpeningSession,
    credential: string,
    sourceIp: string,
    authenticationTimeoutMs: number,
  ): Promise<{ sessionId: string }> {
    const ctx = this.#options.context;
    const signal = opening.controller.signal;
    const work = authenticateServerToken(
      credential,
      ctx.repoDir,
      ctx.repoContext,
      {
        emitter: ctx.auditEmitter,
        instanceId: ctx.instanceId,
        sourceIp,
        ingress: "engine-websocket",
      },
      this.#options.authenticationDeps,
      signal,
    );
    const tracked = work.finally(() =>
      this.#authenticationWork.delete(tracked)
    );
    this.#authenticationWork.add(tracked);
    let rejectAborted!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) =>
      rejectAborted = reject
    );
    const onAbort = () => rejectAborted(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const schedule = this.#options.scheduleAuthenticationDeadline ??
      ((delayMs: number, expired: () => void) => {
        const timer = setTimeout(expired, delayMs);
        return () => clearTimeout(timer);
      });
    const cancelDeadline = schedule(authenticationTimeoutMs, () => {
      this.#retireAuthentication(opening);
    });
    let auth: Awaited<typeof work>;
    try {
      auth = await Promise.race([tracked, aborted]);
    } finally {
      cancelDeadline();
      signal.removeEventListener("abort", onAbort);
    }
    if (!auth.ok) {
      throw new ControlError("unauthorized", "Authentication failed");
    }
    if (opening.cancelled || this.#state !== "ready") {
      throw new ControlError("session_closed", "Authentication was abandoned");
    }
    const reply = this.#publish(sessionId, {
      callerClass: "cli",
      ctx,
      principal: parsePrincipal(auth.principalId),
      oneShot: false,
      expiresInMs: 8 * 60 * 60 * 1000,
    });
    setConnectionCollectives(
      reply,
      auth.collectives,
      auth.groups,
      auth.principalId,
    );
    setConnectionToken(reply, {
      name: auth.tokenName,
      createdAt: auth.tokenCreatedAt,
      principalId: auth.principalId,
    });
    setConnectionLoginIdentity(reply, auth.oauthIdentity);
    setConnectionSourceIp(reply, sourceIp);
    setConnectionTeardown(reply, () => this.#detach(sessionId));
    return { sessionId };
  }
  #publish(
    sessionId: string,
    options: {
      callerClass: CallerClass;
      ctx: ConnectionContext;
      principal: Principal | null;
      oneShot: boolean;
      expiresInMs?: number;
    },
  ): SessionReply {
    let open = true;
    const reply: SessionReply = {
      kind: "session-reply",
      get open() {
        return open;
      },
      send: (message: ServerMessage) => {
        if (!open) return;
        try {
          const admitted = this.#writer.sendSession(sessionId, {
            version: 1,
            generation: this.#generation,
            sessionId,
            message,
          });
          if (!admitted) {
            reply.close(1013, "Engine session output limit reached");
          }
        } catch {
          // A bounded pipe failure detaches this subscriber, never its accepted run.
          reply.close(1013, "Engine output limit reached");
        }
      },
      close: (code = 1000, reason = "Session closed") => {
        if (!open) return;
        open = false;
        this.#detach(sessionId);
        try {
          this.#writer.closeSession(sessionId, {
            version: 1,
            generation: this.#generation,
            sessionId,
            closed: { code, reason: reason.slice(0, 128) },
          });
        } catch {
          // Public output exhaustion has reserved close capacity. At most 128
          // live/pending sessions plus one opener across a flush snapshot can
          // close before the control loop flushes again. Exceeding those 129
          // slots (or invalid close encoding) is an internal transport failure;
          // hiding it would leave Go with a session the engine has forgotten.
          this.#failTransport();
        }
      },
      flush: () => this.#writer.flush(),
    };
    const session: Session = {
      reply,
      callerClass: options.callerClass,
      ctx: options.ctx,
      principal: options.principal,
      requests: new Map(),
      timer: options.expiresInMs === undefined ? undefined : setTimeout(
        () => reply.close(4002, "Session expired; reauthenticate"),
        options.expiresInMs,
      ),
      forwarded: new Set(),
      oneShot: options.oneShot,
      dispatched: false,
    };
    this.#sessions.set(sessionId, session);
    return reply;
  }
  #close(id: string): void {
    const opening = this.#openingSessions.get(id);
    if (opening) this.#retireAuthentication(opening);
    this.#sessions.get(id)?.reply.close();
  }
  #retireAuthentication(opening: OpeningSession): void {
    opening.cancelled = true;
    if (this.#state === "ready") this.#state = "retiring";
    const reason = new ControlError(
      "engine_retiring",
      "Authentication did not finish before cancellation; the engine will retire after accepted work finishes",
    );
    for (const pending of this.#openingSessions.values()) {
      pending.cancelled = true;
      pending.controller.abort(reason);
    }
  }
  #detach(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    clearTimeout(session.timer);
    for (const controller of session.requests.values()) controller.abort();
    removeConnection(session.reply);
  }
  shutdown(deadlineMs: number): Promise<void> {
    if (this.#state === "stopped") return Promise.resolve();
    this.#shutdown ??= this.#drain(deadlineMs);
    return this.#shutdown;
  }
  async #quiesce(deadlineMs: number): Promise<void> {
    try {
      if (!await this.#settlesWithin(this.#dispose(), deadlineMs)) {
        throw new ControlError(
          "drain_timeout",
          "Engine persistence did not finish before the quiescence deadline",
        );
      }
      this.#state = "stopped";
    } catch (error) {
      this.#state = "failed";
      this.#inputCancellation.abort();
      throw error;
    }
  }
  async #drain(deadlineMs: number): Promise<void> {
    const now = this.#options.now ?? (() => performance.now());
    const startedAt = now();
    const disposalGrace = Math.min(5_000, deadlineMs / 3);
    const cancellationGrace = Math.min(5_000, (deadlineMs - disposalGrace) / 2);
    this.#state = "draining";
    this.#actionsStopped.abort();
    const registry = this.#options.context.activeRunRegistry;
    registry?.beginDraining();
    for (const opening of this.#openingSessions.values()) {
      opening.cancelled = true;
      opening.controller.abort(
        new ControlError("session_closed", "Engine shutting down"),
      );
    }
    for (const id of [...this.#sessions.keys()]) this.#close(id);
    const completed = Promise.allSettled([
      ...this.#tasks,
      ...this.#authenticationTasks,
      ...(registry?.list().map((r) => r.completion) ?? []),
    ]);
    if (
      !await this.#settlesWithin(
        completed,
        deadlineMs - cancellationGrace - disposalGrace,
      )
    ) {
      registry?.cancelAll(undefined, "Engine shutting down");
      if (!await this.#settlesWithin(completed, cancellationGrace)) {
        // Persistence remains owned by work that refused cancellation. The
        // process entry exits with failure; closing repositories here would
        // race those writers and falsely claim a successful drain.
        this.#state = "failed";
        this.#inputCancellation.abort();
        throw new ControlError(
          "drain_timeout",
          "Engine work did not stop after cancellation; outcome is indeterminate",
        );
      }
    }
    const remaining = Math.max(0, deadlineMs - (now() - startedAt));
    if (!await this.#settlesWithin(this.#dispose(), remaining)) {
      this.#state = "failed";
      this.#inputCancellation.abort();
      throw new ControlError(
        "drain_timeout",
        "Engine persistence did not finish before the shutdown deadline",
      );
    }
    this.#state = "stopped";
  }
  async #settlesWithin(
    work: Promise<unknown>,
    delayMs: number,
  ): Promise<boolean> {
    const schedule = this.#options.scheduleDeadline ??
      ((ms: number, expired: () => void) => {
        const timer = setTimeout(expired, ms);
        return () => clearTimeout(timer);
      });
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([
        work.then(() => true),
        new Promise<boolean>((resolve) => {
          cancel = schedule(delayMs, () => resolve(false));
        }),
      ]);
    } finally {
      cancel?.();
    }
  }
  #dispose(): Promise<void> {
    this.#disposal ??= (async () => {
      await this.#options.dispose();
      await this.#writer.flush();
    })();
    return this.#disposal;
  }
  #failTransport(): void {
    this.#transportFailed = true;
    this.#inputCancellation.abort();
  }
}
class ControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
function textParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value || value.length > 512) {
    throw new ControlError("invalid_request", "Invalid control parameter");
  }
  return value;
}
function deadlineParam(params: Record<string, unknown>): number {
  if (params.deadlineMs === undefined) return 30_000;
  if (
    typeof params.deadlineMs !== "number" ||
    !Number.isInteger(params.deadlineMs) || params.deadlineMs < 0 ||
    params.deadlineMs > ENGINE_PROTOCOL.limits.maxShutdownDeadlineMs
  ) {
    throw new ControlError("invalid_request", "Invalid shutdown deadline");
  }
  return params.deadlineMs;
}

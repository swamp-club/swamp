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
  PAGE_WORKSPACE,
  serverPath,
  withLocalToken,
} from "./workspace_path.ts";
import {
  backoffDelayMs,
  type CloseAction,
  closeAction,
  probeOutcome,
  type ProbeResult,
} from "./reconnect.ts";

export type AuthMode = "none" | "token" | "oauth";

export interface AuthInfo {
  mode: AuthMode;
  verificationBaseUri?: string;
  /**
   * Set by the local dashboard (`swamp dashboard`), which serves one repo
   * from the CLI with no serve behind it. Serve never sends it.
   */
  local?: true;
  /** a host's workspace that takes a sign-in code from its root at `/auth/exchange` */
  exchange?: true;
}

/** Why a workspace page has no workspace to sign in to. */
export type WorkspaceAbsence =
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable"; readonly state: string | null }
  | { readonly kind: "refused" };

/** A page's `/auth/info` answer: a usable body, or why there is none. */
export type AuthAnswer =
  | { readonly kind: "info"; readonly info: AuthInfo }
  | WorkspaceAbsence;

/** Aborts a token probe or `/auth/info` request that has not answered. */
export const CHECK_TIMEOUT_MS = 10_000;

/** The part of a WebSocket the controller drives. */
export interface SocketLike {
  close(): void;
}

export interface SocketHandlers {
  onOpen(): void;
  /** A decoded text frame. */
  onMessage(text: string): void;
  onClose(code: number): void;
}

export interface Timers {
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
}

export interface ConnectionDeps<S extends SocketLike> extends Timers {
  createSocket(protocols: string[] | undefined, handlers: SocketHandlers): S;
  /** Asks serve over HTTP whether it accepts `token`. */
  probe(token: string | null, signal: AbortSignal): Promise<ProbeResult>;
  /** One `/auth/info` request; null when serve did not answer usefully. */
  fetchAuthInfo(signal: AbortSignal): Promise<AuthInfo | null>;
  random?: () => number;
  checkTimeoutMs?: number;
  onOpen(socket: S): void;
  onMessage(socket: S, text: string): void;
  /** The live socket closed; any requests on it are lost. */
  onDisconnect(): void;
  /**
   * Serve no longer accepts the token. The controller has stopped, and has
   * already reported a changed auth mode through onAuthModeChanged.
   */
  onReauth(): void;
  /** Serve came back in a different auth mode. The controller has stopped. */
  onAuthModeChanged(info: AuthInfo): void;
}

export interface Connection {
  /** Connects, replacing any earlier connection, and keeps reconnecting. */
  start(options: { token: string | null; authMode: AuthMode }): void;
  /** Closes the socket and cancels any pending retry or check. */
  stop(): void;
}

/**
 * Runs one request with a timeout. `onSettle` gets the result, or `failure`
 * if the request rejected or timed out, unless `cancel` is called first.
 */
function attemptWithTimeout<T>(
  timers: Timers,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  failure: T,
  onSettle: (result: T) => void,
): () => void {
  const abort = new AbortController();
  let settled = false;
  const settle = (result: T) => {
    if (settled) return;
    settled = true;
    timers.clearTimer(timer);
    onSettle(result);
  };
  const timer = timers.setTimer(() => {
    abort.abort();
    settle(failure);
  }, timeoutMs);
  run(abort.signal)
    .then(settle, () => settle(failure))
    .catch((err: unknown) => {
      console.error("swamp: connection check failed", err);
    });
  return () => {
    settled = true;
    timers.clearTimer(timer);
    abort.abort();
  };
}

/**
 * Keeps one WebSocket to serve open. After an unexpected close it reconnects
 * with backoff, and it stops for good when serve rejects the token or comes
 * back in a different auth mode. Every side effect is injected.
 */
export function createConnection<S extends SocketLike>(
  deps: ConnectionDeps<S>,
): Connection {
  const random = deps.random ?? Math.random;
  const checkTimeoutMs = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;

  // Bumped by every open and stop; handlers from an older generation are
  // stale and do nothing.
  let generation = 0;
  let token: string | null = null;
  let authMode: AuthMode = "none";
  let attempt = 0;
  let socket: S | null = null;
  // Whether `socket` reached open, so stopping it must report the disconnect.
  let socketOpened = false;
  let retryTimer: number | null = null;
  let cancelCheck: (() => void) | null = null;

  const halt = () => {
    generation++;
    if (retryTimer !== null) {
      deps.clearTimer(retryTimer);
      retryTimer = null;
    }
    cancelCheck?.();
    cancelCheck = null;
    const closing = socket;
    const wasOpen = socketOpened;
    socket = null;
    socketOpened = false;
    closing?.close();
    // The closed socket's own onclose is now stale and will not report it.
    if (wasOpen) deps.onDisconnect();
  };

  const scheduleRetry = () => {
    const gen = generation;
    const delay = backoffDelayMs(attempt, random);
    attempt++;
    retryTimer = deps.setTimer(() => {
      if (gen !== generation) return;
      retryTimer = null;
      open();
    }, delay);
  };

  const check = <T>(
    run: (signal: AbortSignal) => Promise<T>,
    failure: T,
    onResult: (result: T) => void,
  ) => {
    const gen = generation;
    cancelCheck = attemptWithTimeout(
      deps,
      checkTimeoutMs,
      run,
      failure,
      (result) => {
        if (gen !== generation) return;
        cancelCheck = null;
        onResult(result);
      },
    );
  };

  const afterClose = (action: CloseAction) => {
    switch (action) {
      case "retry":
        scheduleRetry();
        return;
      case "reauth":
        // Serve may have come back in another token-based mode; re-read it
        // so login shows the right flow.
        check<AuthInfo | null>(
          (signal) => deps.fetchAuthInfo(signal),
          null,
          (info) => {
            halt();
            if (info !== null && info.mode !== authMode) {
              deps.onAuthModeChanged(info);
            }
            deps.onReauth();
          },
        );
        return;
      case "probe": {
        const presented = token;
        if (presented === null) {
          scheduleRetry();
          return;
        }
        check<ProbeResult>(
          (signal) => deps.probe(presented, signal),
          "network-error",
          (result) => afterClose(probeOutcome(result)),
        );
        return;
      }
      case "recheck-mode":
        check<AuthInfo | null>(
          (signal) => deps.fetchAuthInfo(signal),
          null,
          (info) => {
            if (info !== null && info.mode !== authMode) {
              halt();
              deps.onAuthModeChanged(info);
              return;
            }
            scheduleRetry();
          },
        );
        return;
    }
  };

  const open = () => {
    const gen = ++generation;
    const presented = token;
    let opened = false;
    let created: S | null = null;
    const handlers: SocketHandlers = {
      onOpen: () => {
        if (gen !== generation || created === null) return;
        opened = true;
        socketOpened = true;
        attempt = 0;
        deps.onOpen(created);
      },
      onMessage: (text) => {
        if (gen !== generation || created === null) return;
        deps.onMessage(created, text);
      },
      onClose: (code) => {
        if (gen !== generation) return;
        socket = null;
        socketOpened = false;
        deps.onDisconnect();
        afterClose(
          closeAction({ code, opened, tokenPresented: presented !== null }),
        );
      },
    };
    try {
      created = deps.createSocket(
        socketProtocols(presented, authMode),
        handlers,
      );
    } catch (err) {
      // The constructor throws on a subprotocol it cannot send, such as a
      // malformed token. Treat it as a failed upgrade rather than let it
      // escape a retry timer and end reconnection.
      console.error("swamp: could not open a WebSocket", err);
      afterClose(
        closeAction({
          code: 1006,
          opened: false,
          tokenPresented: presented !== null,
        }),
      );
      return;
    }
    socket = created;
  };

  return {
    start(options) {
      halt();
      token = options.token;
      authMode = options.authMode;
      attempt = 0;
      open();
    },
    stop: halt,
  };
}

/**
 * The subprotocols a dashboard socket requests. Serve echoes the bearer
 * subprotocol only when it authenticates the upgrade, and a browser fails a
 * handshake that asked for one and got none back — so a token left in
 * sessionStorage must not be presented to serve in `none` mode.
 */
export function socketProtocols(
  token: string | null,
  authMode: AuthMode | null,
): string[] | undefined {
  if (!token || authMode === null || authMode === "none") {
    return undefined;
  }
  return [`bearer.${token}`];
}

/** Validates an `/auth/info` body. */
export function parseAuthInfo(value: unknown): AuthInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const { mode, verificationBaseUri, local, exchange } = value as Record<
    string,
    unknown
  >;
  if (mode !== "none" && mode !== "token" && mode !== "oauth") return null;
  return {
    mode,
    ...(typeof verificationBaseUri === "string" ? { verificationBaseUri } : {}),
    ...(local === true ? { local } : {}),
    ...(exchange === true ? { exchange } : {}),
  };
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** One `/auth/info` request; null on a network error or unusable answer. */
export async function requestAuthInfo(
  fetchFn: FetchFn,
  signal: AbortSignal,
): Promise<AuthInfo | null> {
  const answer = await requestAuthAnswer(fetchFn, signal, null);
  return answer?.kind === "info" ? answer.info : null;
}

/** A serve host's JSON refusal (`host_reply.ts`), or null for any other body. */
async function hostRefusal(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "error" in body &&
        typeof body.error === "string"
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * One `/auth/info` request for a page. On a workspace page, a 401 is the local
 * hub refusing the page's token, a 404 from anything says the workspace is not
 * there, and the host's JSON 503 says it is not running; the hub's plain-text
 * 503 stays retryable. Null on a network error or unusable answer.
 */
export async function requestAuthAnswer(
  fetchFn: FetchFn,
  signal: AbortSignal,
  workspace: string | null = PAGE_WORKSPACE,
): Promise<AuthAnswer | null> {
  try {
    const response = await fetchFn(serverPath("/auth/info"), {
      signal,
      headers: withLocalToken(),
    });
    if (response.ok) {
      const info = parseAuthInfo(await response.json());
      return info === null ? null : { kind: "info", info };
    }
    if (workspace !== null && response.status === 401) {
      await response.body?.cancel();
      return { kind: "refused" };
    }
    if (workspace !== null && response.status === 404) {
      await response.body?.cancel();
      return { kind: "absent" };
    }
    if (workspace !== null && response.status === 503) {
      const refusal = await hostRefusal(response);
      if (refusal === null) return null;
      return {
        kind: "unavailable",
        state: typeof refusal.state === "string" ? refusal.state : null,
      };
    }
    await response.body?.cancel();
    return null;
  } catch {
    return null;
  }
}

/**
 * Asks serve whether it accepts `token`. `/api/v1/health` authenticates with
 * the same check as the WebSocket upgrade and answers 401 only for a
 * rejected token.
 *
 * It is heavier than the question needs: any accepted token also runs a full
 * health collection, and every probe records an auth audit event. Probes only
 * follow a failed reconnect and are spaced by backoff; switch to a
 * lightweight token-check endpoint if serve gains one.
 */
export async function requestTokenProbe(
  fetchFn: FetchFn,
  token: string | null,
  signal: AbortSignal,
): Promise<ProbeResult> {
  try {
    const dashboardOrigin = typeof location === "undefined"
      ? undefined
      : location.origin;
    const response = await fetchFn(
      serverPath("/api/v1/health"),
      !token
        ? {
          headers: dashboardOrigin === undefined
            ? undefined
            : { "X-Swamp-Dashboard-Origin": dashboardOrigin },
          signal,
        }
        : { headers: { Authorization: `Bearer ${token}` }, signal },
    );
    await response.body?.cancel();
    return response.status;
  } catch {
    return "network-error";
  }
}

/**
 * Reads `/auth/info`, retrying with backoff until serve answers with a valid
 * mode, a workspace is reported absent, or the local hub refuses the page. A
 * workspace that is not running is reported and retried, so the page recovers
 * once it starts. Returns a function that cancels it.
 */
export function loadAuthInfo(
  deps: Timers & {
    fetchAuthAnswer(signal: AbortSignal): Promise<AuthAnswer | null>;
    random?: () => number;
    checkTimeoutMs?: number;
  },
  onLoaded: (info: AuthInfo) => void,
  onAbsence: (absence: WorkspaceAbsence) => void = () => {},
): () => void {
  const random = deps.random ?? Math.random;
  const checkTimeoutMs = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  let cancelled = false;
  let attempt = 0;
  let retryTimer: number | null = null;
  let cancelRequest: (() => void) | null = null;

  const run = () => {
    cancelRequest = attemptWithTimeout<AuthAnswer | null>(
      deps,
      checkTimeoutMs,
      (signal) => deps.fetchAuthAnswer(signal),
      null,
      (answer) => {
        cancelRequest = null;
        if (cancelled) return;
        if (answer?.kind === "info") {
          onLoaded(answer.info);
          return;
        }
        if (answer !== null) {
          onAbsence(answer);
          if (answer.kind !== "unavailable") return;
        }
        retryTimer = deps.setTimer(() => {
          retryTimer = null;
          if (!cancelled) run();
        }, backoffDelayMs(attempt++, random));
      },
    );
  };
  run();

  return () => {
    cancelled = true;
    if (retryTimer !== null) {
      deps.clearTimer(retryTimer);
      retryTimer = null;
    }
    cancelRequest?.();
    cancelRequest = null;
  };
}

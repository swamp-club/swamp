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

import { serverPath, withLocalToken } from "./workspace_path.ts";
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
}

export const CHECK_TIMEOUT_MS = 10_000;

export interface SocketLike {
  close(): void;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(code: number): void;
}

export interface Timers {
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
}

export interface ConnectionDeps<S extends SocketLike> extends Timers {
  createSocket(protocols: string[] | undefined, handlers: SocketHandlers): S;
  probe(token: string | null, signal: AbortSignal): Promise<ProbeResult>;
  fetchAuthInfo(signal: AbortSignal): Promise<AuthInfo | null>;
  random?: () => number;
  checkTimeoutMs?: number;
  onOpen(socket: S): void;
  onMessage(socket: S, text: string): void;
  onDisconnect(): void;
  /**
   * Serve no longer accepts the token. The controller has stopped, and has
   * already reported a changed auth mode through onAuthModeChanged.
   */
  onReauth(): void;
  onAuthModeChanged(info: AuthInfo): void;
}

export interface Connection {
  start(options: { token: string | null; authMode: AuthMode }): void;
  stop(): void;
}

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

export function parseAuthInfo(value: unknown): AuthInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const { mode, verificationBaseUri, local } = value as Record<
    string,
    unknown
  >;
  if (mode !== "none" && mode !== "token" && mode !== "oauth") return null;
  return {
    mode,
    ...(typeof verificationBaseUri === "string" ? { verificationBaseUri } : {}),
    ...(local === true ? { local } : {}),
  };
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export async function requestAuthInfo(
  fetchFn: FetchFn,
  signal: AbortSignal,
): Promise<AuthInfo | null> {
  try {
    const response = await fetchFn(serverPath("/auth/info"), {
      signal,
      headers: withLocalToken(),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return parseAuthInfo(await response.json());
  } catch {
    return null;
  }
}

/**
 * /api/v1/health authenticates like the WebSocket upgrade and answers 401 only
 * for a rejected token; heavier than needed, so probes only follow a failed
 * reconnect, spaced by backoff
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

export function loadAuthInfo(
  deps: Timers & {
    fetchAuthInfo(signal: AbortSignal): Promise<AuthInfo | null>;
    random?: () => number;
    checkTimeoutMs?: number;
  },
  onLoaded: (info: AuthInfo) => void,
): () => void {
  const random = deps.random ?? Math.random;
  const checkTimeoutMs = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  let cancelled = false;
  let attempt = 0;
  let retryTimer: number | null = null;
  let cancelRequest: (() => void) | null = null;

  const run = () => {
    cancelRequest = attemptWithTimeout<AuthInfo | null>(
      deps,
      checkTimeoutMs,
      (signal) => deps.fetchAuthInfo(signal),
      null,
      (info) => {
        cancelRequest = null;
        if (cancelled) return;
        if (info !== null) {
          onLoaded(info);
          return;
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

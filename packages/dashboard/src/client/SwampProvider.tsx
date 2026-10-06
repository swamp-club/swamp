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
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AuthInfo,
  type Connection,
  createConnection,
  loadAuthInfo,
  requestAuthInfo,
  requestTokenProbe,
  type SocketHandlers,
} from "./connection.ts";
import { createDashboardSessionClient } from "./dashboard_session.ts";
import {
  detachFrame,
  RequestError,
  settleDetached,
  settleRequest,
  type WireFrame,
} from "./stream";

interface SwampContextValue {
  connected: boolean;
  token: string | null;
  sessionReady: boolean;
  authMode: AuthInfo["mode"] | null;
  verificationBaseUri: string | null;
  login: (token: string) => Promise<void>;
  completeLogin: () => Promise<void>;
  logout: () => void;
  request: <T = Record<string, unknown>>(
    type: string,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
  /**
   * Starts a request whose run serve drives itself (e.g. `workflow.resume`),
   * resolves once it has started, and stops following it without cancelling
   * the run.
   */
  requestDetached: (
    type: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}

const SwampContext = createContext<SwampContextValue | null>(null);
const SESSION_CHANNEL = "swamp-dashboard-session";
const dashboardSession = createDashboardSessionClient(globalThis.fetch);

interface DashboardSessionEvent {
  readonly type: "logout" | "reauthenticated";
  readonly sourceId: string;
}

function isDashboardSessionEvent(
  value: unknown,
): value is DashboardSessionEvent {
  return typeof value === "object" && value !== null &&
    "type" in value && "sourceId" in value &&
    (value.type === "logout" || value.type === "reauthenticated") &&
    typeof value.sourceId === "string";
}

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Ask serve to send large responses as gzip binary frames.
  return `${proto}//${location.host}/?compress=gzip`;
}

const timers = {
  setTimer: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
  clearTimer: (id: number) => window.clearTimeout(id),
};

const fetchAuthInfo = (signal: AbortSignal) =>
  requestAuthInfo(globalThis.fetch, signal);

async function gunzipFrame(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return await new Response(stream).text();
}

export function SwampProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [authMode, setAuthMode] = useState<AuthInfo["mode"] | null>(null);
  const [verificationBaseUri, setVerificationBaseUri] = useState<string | null>(
    null,
  );
  const socketRef = useRef<WebSocket | null>(null);
  const sessionGenerationRef = useRef(0);
  const sessionSourceIdRef = useRef(crypto.randomUUID());
  const pendingRef = useRef<
    Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        detached?: boolean;
      }
    >
  >(new Map());

  const applyAuthInfo = useCallback((info: AuthInfo) => {
    setAuthMode(info.mode);
    setVerificationBaseUri(info.verificationBaseUri ?? null);
  }, []);

  const restoreSession = useCallback(async (signal?: AbortSignal) => {
    const generation = ++sessionGenerationRef.current;
    try {
      const restored = await dashboardSession.restore(signal);
      if (generation !== sessionGenerationRef.current) return false;
      setToken(restored ? "" : null);
      return restored;
    } catch (error) {
      if (generation === sessionGenerationRef.current) setToken(null);
      throw error;
    }
  }, []);

  // Serve may be down when the page loads; keep asking rather than guess a
  // mode, which would connect without a token and never show login.
  useEffect(() => loadAuthInfo({ ...timers, fetchAuthInfo }, applyAuthInfo), [
    applyAuthInfo,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    restoreSession(controller.signal)
      .catch(() => {})
      .finally(() => {
        if (active) setSessionReady(true);
      });
    return () => {
      active = false;
      sessionGenerationRef.current++;
      controller.abort();
    };
  }, [restoreSession]);

  const clearToken = useCallback(() => {
    sessionGenerationRef.current++;
    setToken(null);
  }, []);

  const sessionAuthenticated = useCallback(async () => {
    if (!(await restoreSession())) throw new Error("Authentication failed");
  }, [restoreSession]);

  const notifyReauthenticated = useCallback(() => {
    if (!("BroadcastChannel" in globalThis)) return;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.postMessage(
      {
        type: "reauthenticated",
        sourceId: sessionSourceIdRef.current,
      } satisfies DashboardSessionEvent,
    );
    channel.close();
  }, []);

  const completeLogin = useCallback(async () => {
    await sessionAuthenticated();
    notifyReauthenticated();
  }, [notifyReauthenticated, sessionAuthenticated]);

  // Built once, on first render: the callbacks it captures (clearToken,
  // applyAuthInfo, the refs) must stay stable, so keep their deps empty.
  const connectionRef = useRef<Connection | null>(null);
  if (connectionRef.current === null) {
    const handleFrame = (ws: WebSocket, text: string) => {
      let msg: WireFrame;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      const pending = pendingRef.current.get(msg.id);
      if (!pending) return;

      const outcome = pending.detached
        ? settleDetached(msg)
        : settleRequest(msg);
      if (outcome.kind === "ignore") return;

      pendingRef.current.delete(msg.id);
      if (outcome.kind === "reject") {
        pending.reject(
          new RequestError(outcome.message, outcome.code, outcome.details),
        );
        return;
      }
      if (outcome.detach && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(detachFrame(msg.id)));
      }
      pending.resolve(outcome.value);
    };

    const createSocket = (
      protocols: string[] | undefined,
      handlers: SocketHandlers,
    ): WebSocket => {
      const ws = new WebSocket(getWsUrl(), protocols);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => handlers.onOpen();
      // Every frame goes through one chain so a text frame never overtakes an
      // earlier compressed frame that is still being decoded.
      let frameChain: Promise<void> = Promise.resolve();
      ws.onmessage = (event) => {
        const data: unknown = event.data;
        frameChain = frameChain
          .then(async () => {
            handlers.onMessage(
              typeof data === "string"
                ? data
                : await gunzipFrame(data as ArrayBuffer),
            );
          })
          .catch((err: unknown) => {
            console.error("swamp: dropped an undecodable frame", err);
          });
      };
      ws.onclose = (event) => handlers.onClose(event.code);
      return ws;
    };

    connectionRef.current = createConnection<WebSocket>({
      ...timers,
      createSocket,
      probe: (authToken, signal) =>
        requestTokenProbe(globalThis.fetch, authToken, signal),
      fetchAuthInfo,
      onOpen: (ws) => {
        socketRef.current = ws;
        setConnected(true);
      },
      onMessage: handleFrame,
      onDisconnect: () => {
        socketRef.current = null;
        setConnected(false);
        for (const [id, p] of pendingRef.current) {
          p.reject(new Error("WebSocket closed"));
          pendingRef.current.delete(id);
        }
      },
      onReauth: clearToken,
      onAuthModeChanged: applyAuthInfo,
    });
  }

  useEffect(() => {
    if (!("BroadcastChannel" in globalThis)) return;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (
        !isDashboardSessionEvent(event.data) ||
        event.data.sourceId === sessionSourceIdRef.current
      ) {
        return;
      }
      if (event.data.type === "logout") {
        connectionRef.current?.stop();
        clearToken();
        return;
      }
      if (event.data.type === "reauthenticated") {
        connectionRef.current?.stop();
        clearToken();
        sessionAuthenticated().catch(() => {});
      }
    };
    return () => channel.close();
  }, [clearToken, sessionAuthenticated]);

  useEffect(() => {
    const connection = connectionRef.current;
    if (!connection) return;
    if (authMode === "none") {
      connection.start({ token: null, authMode });
    } else if (sessionReady && authMode !== null && token !== null) {
      connection.start({ token, authMode });
    }
    return () => connection.stop();
  }, [token, authMode, sessionReady]);

  const login = useCallback(async (newToken: string) => {
    if (!(await dashboardSession.exchange(newToken))) {
      throw new Error("Authentication failed");
    }
    setToken("");
    notifyReauthenticated();
  }, [notifyReauthenticated]);

  const logout = useCallback(() => {
    dashboardSession.clear()
      .then(() => {
        connectionRef.current?.stop();
        clearToken();
        if ("BroadcastChannel" in globalThis) {
          const channel = new BroadcastChannel(SESSION_CHANNEL);
          channel.postMessage(
            {
              type: "logout",
              sourceId: sessionSourceIdRef.current,
            } satisfies DashboardSessionEvent,
          );
          channel.close();
        }
      })
      .catch((error: unknown) => {
        console.error("swamp: could not log out of the dashboard", error);
      });
  }, [clearToken]);

  const send = useCallback(
    (
      type: string,
      payload: Record<string, unknown> | undefined,
      detached: boolean,
    ): Promise<unknown> => {
      return new Promise((resolve, reject) => {
        if (
          !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN
        ) {
          reject(new Error("Not connected"));
          return;
        }
        const id = crypto.randomUUID();
        pendingRef.current.set(id, { resolve, reject, detached });
        const msg: Record<string, unknown> = { type, id };
        if (payload !== undefined) {
          msg.payload = payload;
        }
        socketRef.current.send(JSON.stringify(msg));
      });
    },
    [],
  );

  const request = useCallback(
    <T = Record<string, unknown>>(
      type: string,
      payload?: Record<string, unknown>,
    ): Promise<T> => send(type, payload, false) as Promise<T>,
    [send],
  );

  const requestDetached = useCallback(
    async (type: string, payload?: Record<string, unknown>): Promise<void> => {
      await send(type, payload, true);
    },
    [send],
  );

  return (
    <SwampContext.Provider
      value={{
        connected,
        token,
        sessionReady,
        authMode,
        verificationBaseUri,
        login,
        completeLogin,
        logout,
        request,
        requestDetached,
      }}
    >
      {children}
    </SwampContext.Provider>
  );
}

export function useSwamp(): SwampContextValue {
  const ctx = useContext(SwampContext);
  if (!ctx) throw new Error("useSwamp must be used within SwampProvider");
  return ctx;
}

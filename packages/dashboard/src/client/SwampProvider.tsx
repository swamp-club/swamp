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
  detachFrame,
  settleDetached,
  settleRequest,
  type WireFrame,
} from "./stream";

interface AuthInfo {
  mode: "none" | "token" | "oauth";
  verificationBaseUri?: string;
}

interface SwampContextValue {
  connected: boolean;
  token: string | null;
  authMode: AuthInfo["mode"] | null;
  verificationBaseUri: string | null;
  login: (token: string) => void;
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

const TOKEN_KEY = "swamp-dashboard-token";

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Ask serve to send large responses as gzip binary frames.
  return `${proto}//${location.host}/?compress=gzip`;
}

async function gunzipFrame(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return await new Response(stream).text();
}

export function SwampProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState<string | null>(
    () => sessionStorage.getItem(TOKEN_KEY),
  );
  const [authMode, setAuthMode] = useState<AuthInfo["mode"] | null>(null);
  const [verificationBaseUri, setVerificationBaseUri] = useState<string | null>(
    null,
  );
  const socketRef = useRef<WebSocket | null>(null);
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

  useEffect(() => {
    fetch("/auth/info")
      .then((r) => r.json())
      .then((info: AuthInfo) => {
        setAuthMode(info.mode);
        setVerificationBaseUri(info.verificationBaseUri ?? null);
      })
      .catch(() => setAuthMode("none"));
  }, []);

  const connect = useCallback((authToken: string | null) => {
    if (socketRef.current) {
      socketRef.current.close();
    }

    const protocols = authToken ? [`bearer.${authToken}`] : undefined;
    const ws = new WebSocket(getWsUrl(), protocols);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      socketRef.current = ws;
      setConnected(true);
    };

    const handleFrame = (text: string) => {
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
        pending.reject(new Error(outcome.message));
        return;
      }
      if (outcome.detach && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(detachFrame(msg.id)));
      }
      pending.resolve(outcome.value);
    };

    // Every frame goes through one chain so a text frame never overtakes an
    // earlier compressed frame that is still being decoded.
    let frameChain: Promise<void> = Promise.resolve();
    ws.onmessage = (event) => {
      const data: unknown = event.data;
      frameChain = frameChain
        .then(async () => {
          handleFrame(
            typeof data === "string"
              ? data
              : await gunzipFrame(data as ArrayBuffer),
          );
        })
        .catch((err: unknown) => {
          console.error("swamp: dropped an undecodable frame", err);
        });
    };

    ws.onclose = () => {
      socketRef.current = null;
      setConnected(false);
      for (const [id, p] of pendingRef.current) {
        p.reject(new Error("WebSocket closed"));
        pendingRef.current.delete(id);
      }
    };

    ws.onerror = () => {
      setConnected(false);
    };
  }, []);

  useEffect(() => {
    if (authMode === "none") {
      connect(null);
    } else if (token) {
      connect(token);
    }
    return () => {
      socketRef.current?.close();
    };
  }, [token, authMode, connect]);

  const login = useCallback((newToken: string) => {
    sessionStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    socketRef.current?.close();
  }, []);

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
        authMode,
        verificationBaseUri,
        login,
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

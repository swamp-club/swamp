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
}

const SwampContext = createContext<SwampContextValue | null>(null);

const TOKEN_KEY = "swamp-dashboard-token";

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/`;
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

    ws.onopen = () => {
      socketRef.current = ws;
      setConnected(true);
    };

    ws.onmessage = (event) => {
      let msg: {
        type: string;
        id: string;
        payload?: unknown;
        error?: { code: string; message: string };
        event?: { kind: string; [k: string]: unknown };
      };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const pending = pendingRef.current.get(msg.id);
      if (!pending) return;

      if (msg.type === "error" && msg.error) {
        pendingRef.current.delete(msg.id);
        pending.reject(new Error(msg.error.message));
        return;
      }

      if ("payload" in msg && msg.payload !== undefined) {
        pendingRef.current.delete(msg.id);
        pending.resolve(msg.payload);
      }
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

  const request = useCallback(
    <T = Record<string, unknown>>(
      type: string,
      payload?: Record<string, unknown>,
    ): Promise<T> => {
      return new Promise((resolve, reject) => {
        if (
          !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN
        ) {
          reject(new Error("Not connected"));
          return;
        }
        const id = crypto.randomUUID();
        pendingRef.current.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        const msg: Record<string, unknown> = { type, id };
        if (payload !== undefined) {
          msg.payload = payload;
        }
        socketRef.current.send(JSON.stringify(msg));
      });
    },
    [],
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

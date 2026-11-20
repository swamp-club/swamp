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

import { useEffect, useRef, useState } from "react";
import { APP_READY_MESSAGE, type BridgePort } from "../../../app-sdk/bridge.ts";
import { APP_SANDBOX } from "../../../app-sdk/headers.ts";
import { useSwamp } from "../client/SwampProvider.tsx";
import { serverPath, withLocalToken } from "../client/workspace_path.ts";
import type { HealthSnapshot } from "../client/useHealthStream.ts";
import {
  HTTP_REQUEST_TYPES,
  requestOverHttp,
  SERVE_REQUEST_PATH,
} from "../client/http_request.ts";
import {
  browserTimers,
  fetchAuthInfo,
  openServeSocket,
  probeToken,
} from "../client/serve_socket.ts";
import { AppBroker } from "./broker.ts";
import {
  AppConnection,
  type AppConnectionDeps,
  appConnectionStart,
} from "./app_connection.ts";
import { FrameGuard, isDevLaunch, needsLaunch } from "./frame_guard.ts";
import { readAppTheme, watchAppTheme } from "./theme.ts";
import type { AppLaunchReply } from "./app_types.ts";

interface AppFrameProps {
  name: string;
  path: string;
  health: HealthSnapshot | null;
  onNavigate(path: string): void;
}

/** Browsers intersect the iframe's sandbox with the CSP's, so both use APP_SANDBOX. */
const FRAME_SANDBOX = APP_SANDBOX;

const appConnectionDeps: AppConnectionDeps = {
  ...browserTimers,
  createSocket: openServeSocket,
  probe: probeToken,
  fetchAuthInfo,
  readOverHttp: (request, signal) =>
    requestOverHttp(
      globalThis.fetch,
      serverPath(SERVE_REQUEST_PATH),
      withLocalToken(),
      request,
      signal,
    ),
};

export function frameSrc(url: string): string {
  return isDevLaunch(url) ? url : serverPath(url);
}

export function AppFrame({ name, path, health, onNavigate }: AppFrameProps) {
  const { connected, local, request, token, authMode, sessionReady } =
    useSwamp();
  const [launch, setLaunch] = useState<AppLaunchReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const brokerRef = useRef<AppBroker | null>(null);
  const connectionRef = useRef<AppConnection | null>(null);
  const guard = useRef(new FrameGuard(false));
  const [left, setLeft] = useState(false);
  const healthListeners = useRef(new Set<(snapshot: unknown) => void>());
  const auth = { token, authMode, sessionReady };
  const live = useRef({ health, path, onNavigate, auth });
  live.current = { health, path, onNavigate, auth };

  useEffect(() => {
    if (!needsLaunch(connected, launch)) return;
    let current = true;
    setError(null);
    request<{ data: AppLaunchReply }>("app.launch", { name })
      .then((reply) => {
        if (current) setLaunch(reply.data);
      })
      .catch((reason: unknown) => {
        if (current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      current = false;
    };
    // a reconnect keeps the frame; the bridge outlives the socket
  }, [name, attempt, connected && launch === null]);

  useEffect(() => {
    if (launch === null) return;
    guard.current = new FrameGuard(isDevLaunch(launch.url));
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (
        event.data !== APP_READY_MESSAGE || frame === null ||
        event.source !== frame.contentWindow
      ) {
        return;
      }
      if (!guard.current.mayGrantPort()) return;
      brokerRef.current?.close();
      const channel = new MessageChannel();
      const now = live.current;
      let broker: AppBroker | null = null;
      // one socket per document, so no other app or view shares its limits
      const connection = new AppConnection(
        appConnectionDeps,
        (isConnected) => broker?.setConnected(isConnected),
      );
      broker = new AppBroker(
        channel.port1 as unknown as BridgePort,
        {
          app: {
            name: launch.name,
            title: launch.title,
            capabilities: launch.capabilities,
            run: launch.run,
            methods: launch.methods,
            local,
          },
          theme: readAppTheme(),
          connected: connection.connected,
          path: now.path,
          host: {
            sendFrame: (out, onFrame) => connection.sendFrame(out, onFrame),
            isHttpRead: (type) => HTTP_REQUEST_TYPES.has(type),
            request: (type, payload) => connection.request(type, payload),
            subscribeHealth: (onSnapshot) => {
              healthListeners.current.add(onSnapshot);
              if (live.current.health !== null) onSnapshot(live.current.health);
              return () => healthListeners.current.delete(onSnapshot);
            },
            navigate: (next) => live.current.onNavigate(next),
            close: () => {
              connection.close();
              if (connectionRef.current === connection) {
                connectionRef.current = null;
              }
            },
          },
        },
      );
      brokerRef.current = broker;
      connectionRef.current = connection;
      connection.start(appConnectionStart(now.auth));
      // an opaque origin cannot be named, and only this frame was checked above
      frame.contentWindow?.postMessage(APP_READY_MESSAGE, "*", [channel.port2]);
    };
    globalThis.addEventListener("message", onMessage);
    return () => {
      globalThis.removeEventListener("message", onMessage);
      brokerRef.current?.close();
      brokerRef.current = null;
    };
  }, [launch, local]);

  useEffect(() => {
    connectionRef.current?.start(
      appConnectionStart({ token, authMode, sessionReady }),
    );
  }, [token, authMode, sessionReady]);
  useEffect(() => brokerRef.current?.setPath(path), [path]);
  useEffect(() => {
    if (health === null) return;
    for (const listener of healthListeners.current) listener(health);
  }, [health]);
  useEffect(
    () => watchAppTheme((theme) => brokerRef.current?.setTheme(theme)),
    [],
  );
  useEffect(() => {
    const notify = () =>
      brokerRef.current?.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", notify);
    return () => document.removeEventListener("visibilitychange", notify);
  }, []);

  const reopen = () => {
    setLeft(false);
    setError(null);
    setLaunch(null);
    setAttempt((count) => count + 1);
  };

  if (error !== null) {
    return (
      <div className="empty-state" role="alert">
        <strong>{name} could not open</strong>
        <span>{error}</span>
        <button type="button" className="btn-sm" onClick={reopen}>Retry</button>
      </div>
    );
  }
  if (launch === null) return <div className="app-frame-loading">Opening…</div>;
  if (left) {
    return (
      <div className="empty-state" role="alert">
        <strong>{launch.title} left its page</strong>
        <span>It has been disconnected from swamp.</span>
        <button type="button" className="btn-sm" onClick={reopen}>
          Reopen
        </button>
      </div>
    );
  }
  return (
    <iframe
      ref={frameRef}
      className="app-frame"
      title={launch.title}
      src={frameSrc(launch.url)}
      sandbox={FRAME_SANDBOX}
      onLoad={() => {
        if (guard.current.loaded()) {
          brokerRef.current?.close();
          brokerRef.current = null;
          setLeft(true);
        }
      }}
    />
  );
}

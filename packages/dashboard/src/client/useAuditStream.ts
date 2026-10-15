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

import { localSocketProtocols, serverPath } from "./workspace_path.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { socketProtocols } from "./connection.ts";
import { useSwamp } from "./SwampProvider.tsx";
import { requestErrorInfo } from "./stream.ts";
import {
  type AuditProblem,
  type AuditStatus,
  auditStatus,
  classifyAuditError,
} from "./audit_state.ts";

export interface AuditEvent {
  id: string;
  timestamp: string;
  instanceId: string;
  category: string;
  stage: string;
  outcome: string;
  action: string;
  resourceKind: string;
  resourceName: string;
  principalKind: string;
  principalId: string;
  initiatedBy: string;
  principalUsername?: string;
  principalEmail?: string;
  sourceIp: string;
  requestId: string;
  methodName?: string;
  detail?: string;
  decision?: Record<string, unknown>;
}

const DEFAULT_MAX_EVENTS = 1000;

export interface AuditStream {
  events: AuditEvent[];
  streaming: boolean;
  liveEnabled: boolean;
  error: string | null;
  /** Where the feed stands; see `AuditStatus`. */
  status: AuditStatus;
  /** True once the first `audit.query` answered (or failed). */
  historyLoaded: boolean;
  clearEvents: () => void;
  setLiveEnabled: (enabled: boolean) => void;
  /** Subscribes again after the live feed failed. */
  reconnect: () => void;
  maxEvents: number;
  setMaxEvents: (n: number) => void;
}

export function useAuditStream(): AuditStream {
  const { connected, request, token, authMode } = useSwamp();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [maxEvents, setMaxEvents] = useState(DEFAULT_MAX_EVENTS);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<AuditProblem | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  const clearEvents = useCallback(() => setEvents([]), []);
  const reconnect = useCallback(() => {
    setProblem(null);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);
  const setLive = useCallback((enabled: boolean) => {
    // Resuming retries a feed that failed; disabled and denied stay put.
    if (enabled) setProblem((p) => (p === "error" ? null : p));
    setLiveEnabled(enabled);
  }, []);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;

    (async () => {
      try {
        const result = await request<{
          events: AuditEvent[];
          total?: number;
        }>("audit.query", { limit: maxEvents });
        if (!cancelled) {
          setEvents(
            (result.events ?? []).slice(-maxEvents) as AuditEvent[],
          );
        }
      } catch (err) {
        // The live subscription reports a missing audit log; a refusal
        // here is the only sign the history is off limits.
        const kind = classifyAuditError(requestErrorInfo(err)?.code);
        if (!cancelled && kind === "denied") {
          setProblem("denied");
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setHistoryLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connected, request, maxEvents]);

  useEffect(() => {
    if (!connected || !liveEnabled) {
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "audit.unsubscribe",
            id: crypto.randomUUID(),
          }));
          wsRef.current.close();
        } else {
          wsRef.current.close();
        }
        wsRef.current = null;
      }
      setStreaming(false);
      return;
    }

    let cancelled = false;
    // Set once serve answered the subscription with an error, so the close
    // that follows is not reported as a dropped feed.
    let failed = false;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}${serverPath("/")}`;
    const ws = new WebSocket(
      wsUrl,
      localSocketProtocols() ?? socketProtocols(token, authMode),
    );
    wsRef.current = ws;

    ws.onopen = () => {
      if (cancelled) {
        ws.close();
        return;
      }
      ws.send(JSON.stringify({
        type: "audit.subscribe",
        id: crypto.randomUUID(),
      }));
    };

    ws.onmessage = (event) => {
      let msg: {
        type: string;
        id: string;
        payload?: Record<string, unknown>;
      };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      if (msg.type === "audit.subscribe" && msg.payload) {
        if (!cancelled) {
          setStreaming(true);
          setError(null);
          setProblem(null);
        }
        return;
      }

      if (msg.type === "error") {
        const errPayload = msg as unknown as {
          error?: { code?: string; message?: string };
        };
        failed = true;
        if (!cancelled) {
          setProblem(classifyAuditError(errPayload.error?.code));
          setError(errPayload.error?.message ?? "Subscription failed");
          setStreaming(false);
        }
        return;
      }

      if (msg.type === "audit.event" && msg.payload) {
        const auditEvent = (msg.payload as { event: AuditEvent }).event;
        if (!cancelled) {
          setEvents((prev) => {
            const next = [...prev, auditEvent];
            return next.length > maxEvents ? next.slice(-maxEvents) : next;
          });
        }
      }
    };

    ws.onclose = () => {
      if (!cancelled) {
        setStreaming(false);
        if (!failed) {
          setProblem((p) => p ?? "error");
          setError((e) => e ?? "The live feed disconnected");
        }
      }
      wsRef.current = null;
    };

    ws.onerror = () => {
      failed = true;
      if (!cancelled) {
        setProblem((p) => p ?? "error");
        setError("WebSocket connection failed");
        setStreaming(false);
      }
    };

    return () => {
      cancelled = true;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "audit.unsubscribe",
          id: crypto.randomUUID(),
        }));
        ws.close();
      }
      wsRef.current = null;
    };
  }, [connected, token, authMode, liveEnabled, maxEvents, attempt]);

  return {
    events,
    streaming,
    liveEnabled,
    error,
    status: auditStatus({ liveEnabled, streaming, problem }),
    historyLoaded,
    clearEvents,
    setLiveEnabled: setLive,
    reconnect,
    maxEvents,
    setMaxEvents,
  };
}

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

import { useCallback, useEffect, useRef, useState } from "react";
import { useSwamp } from "./SwampProvider";

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
  sourceIp: string;
  requestId: string;
  methodName?: string;
  detail?: string;
  decision?: Record<string, unknown>;
}

const DEFAULT_MAX_EVENTS = 1000;

export function useAuditStream(): {
  events: AuditEvent[];
  streaming: boolean;
  liveEnabled: boolean;
  error: string | null;
  clearEvents: () => void;
  setLiveEnabled: (enabled: boolean) => void;
  maxEvents: number;
  setMaxEvents: (n: number) => void;
} {
  const { connected, request, token } = useSwamp();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [maxEvents, setMaxEvents] = useState(DEFAULT_MAX_EVENTS);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const clearEvents = useCallback(() => setEvents([]), []);

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
      } catch {
        // audit may not be configured
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connected, request, maxEvents]);

  useEffect(() => {
    if (!connected || !liveEnabled) {
      if (wsRef.current) {
        wsRef.current.send(JSON.stringify({
          type: "audit.unsubscribe",
          id: crypto.randomUUID(),
        }));
        wsRef.current.close();
        wsRef.current = null;
      }
      setStreaming(false);
      return;
    }

    let cancelled = false;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/`;
    const protocols = token ? [`bearer.${token}`] : undefined;
    const ws = new WebSocket(wsUrl, protocols);
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
        }
        return;
      }

      if (msg.type === "error") {
        const errPayload = msg as unknown as {
          error?: { message: string };
        };
        if (!cancelled) {
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
      if (!cancelled) setStreaming(false);
      wsRef.current = null;
    };

    ws.onerror = () => {
      if (!cancelled) {
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
  }, [connected, token, liveEnabled, maxEvents]);

  return {
    events,
    streaming,
    liveEnabled,
    error,
    clearEvents,
    setLiveEnabled,
    maxEvents,
    setMaxEvents,
  };
}

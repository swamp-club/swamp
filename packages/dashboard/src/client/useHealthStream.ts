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
import { useEffect, useState } from "react";
import { useSwamp } from "./SwampProvider.tsx";
import {
  HEALTH_RETRY_MS,
  healthRetryDelayMs,
  healthStreamOutcome,
} from "./health_state.ts";

interface ActiveRun {
  runId: string;
  kind: string;
  resourceName: string;
  durationMs: number;
  principalId?: string;
}

interface HealthMetrics {
  completions: number;
  failures: number;
  cancellations: number;
  throughputPerMinute: number;
  latency: {
    p50: number;
    p95: number;
    p99: number;
  };
}

interface WorkerSnapshot {
  name: string;
  status: string;
  activeDispatchIds: string[];
}

export interface ScheduleEntry {
  workflowId: string;
  workflowName: string;
  cronExpression: string;
  nextRun: string | null;
  running: boolean;
  /** Unset on servers that predate queue reporting (swamp-club#3046). */
  queued?: number;
  oldestQueuedAt?: string | null;
  lastQueueDelayMs?: number | null;
}

export interface WebhookEntry {
  route: string;
  /** The configured workflow id or name. */
  workflow: string;
  /** Signature verification scheme, when serve reports it. */
  scheme?: string;
  /** Unset on servers that predate webhook queue reporting (swamp-club#3665). */
  active?: number;
  queued?: number;
  oldestQueuedAt?: string | null;
  lastQueueDelayMs?: number | null;
}

interface ComponentHealth {
  name: string;
  healthy: boolean;
  message?: string;
  latencyMs?: number;
}

export interface HealthSnapshot {
  instanceId: string;
  deploymentMode: string;
  uptimeMs: number;
  ready: boolean;
  activeRuns: ActiveRun[];
  metrics: HealthMetrics;
  workers: WorkerSnapshot[];
  scheduling: {
    enabled: boolean;
    schedules: ScheduleEntry[];
    /** The IANA zone serve's scheduler reads cron in; absent on older serves. */
    timeZone?: string;
  };
  webhooks: WebhookEntry[];
  components: ComponentHealth[];
}

export interface HealthStream {
  health: HealthSnapshot | null;
  /** Serve refused the stream for this token. */
  denied: boolean;
}

/** How one pass over the health stream ended. */
export type HealthStreamEnd =
  | { kind: "denied" }
  | { kind: "retry"; retryMs: number };

/**
 * Opens the health stream once and reads it until it ends or `signal`
 * aborts, handing each snapshot to `onSnapshot`. Says whether serve refused
 * the token or how long to wait before the next pass. Nothing reaches
 * `onSnapshot` once `signal` has aborted.
 */
export async function readHealthStream(
  { url, headers, signal, onOpen, onSnapshot, fetchFn = fetch }: {
    url: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    /** Serve accepted the stream. */
    onOpen: () => void;
    onSnapshot: (snapshot: HealthSnapshot) => void;
    fetchFn?: typeof fetch;
  },
): Promise<HealthStreamEnd> {
  let retryMs = HEALTH_RETRY_MS;
  try {
    const resp = await fetchFn(url, { headers, signal });

    const outcome = healthStreamOutcome(resp.status);
    if (outcome === "denied") {
      await resp.body?.cancel();
      return { kind: "denied" };
    }

    if (outcome === "ok" && resp.body) {
      if (!signal.aborted) onOpen();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let event = "message";

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line === "") {
            event = "message";
          } else if (line.startsWith("event: ")) {
            event = line.slice(7);
          } else if (line.startsWith("data: ") && event === "health") {
            try {
              const snapshot = JSON.parse(line.slice(6)) as HealthSnapshot;
              if (!signal.aborted) onSnapshot(snapshot);
            } catch {
              // ignore parse errors
            }
          }
          // A session-ended event precedes the server closing the
          // stream; the reconnect after it then learns whether the token
          // still works.
        }
      }
    } else {
      retryMs = healthRetryDelayMs(resp.headers.get("Retry-After"));
      await resp.body?.cancel();
    }
  } catch {
    // reconnect after delay
  }
  return { kind: "retry", retryMs };
}

/**
 * Serve's health snapshot, streamed while `visible`. A hidden tab closes the
 * stream and keeps the last snapshot; coming back into view reconnects, and
 * serve sends a snapshot as soon as a stream opens (swamp-club#3661). A
 * refused token stays refused until the token changes or the tab comes
 * back into view, which tries it once more.
 */
export function useHealthStream(
  visible: boolean,
  intervalMs = 5000,
): HealthStream {
  const { token } = useSwamp();
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [denied, setDenied] = useState(false);

  // A new token starts from scratch: what the last one saw no longer holds.
  useEffect(() => {
    setHealth(null);
    setDenied(false);
  }, [token]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout>;
    // Aborting on cleanup closes the connection itself; serve counts each
    // open stream against the token's limit until it closes.
    const abort = new AbortController();

    async function connect() {
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      } else {
        headers["X-Swamp-Dashboard-Origin"] = globalThis.location.origin;
      }

      const end = await readHealthStream({
        url: serverPath(`/api/v1/health/stream?interval=${intervalMs}`),
        headers: withLocalToken(headers),
        signal: abort.signal,
        onOpen: () => setDenied(false),
        onSnapshot: setHealth,
      });
      if (cancelled) return;
      if (end.kind === "denied") {
        setHealth(null);
        setDenied(true);
        return;
      }
      retryTimeout = setTimeout(connect, end.retryMs);
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimeout);
      abort.abort();
    };
  }, [token, intervalMs, visible]);

  return { health, denied };
}

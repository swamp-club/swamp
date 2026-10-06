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

import { useEffect, useState } from "react";
import { useSwamp } from "./SwampProvider";
import {
  HEALTH_RETRY_MS,
  healthRetryDelayMs,
  healthStreamOutcome,
} from "./health_state";

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

interface ScheduleEntry {
  workflowId: string;
  workflowName: string;
  cronExpression: string;
  nextRun: string | null;
  running: boolean;
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
  };
  webhooks: Array<{ route: string; workflow: string }>;
  components: ComponentHealth[];
}

export interface HealthStream {
  health: HealthSnapshot | null;
  /** Serve refused the stream for this token. */
  denied: boolean;
}

export function useHealthStream(intervalMs = 5000): HealthStream {
  const { token } = useSwamp();
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout>;
    // Aborting on cleanup closes the connection itself; serve counts each
    // open stream against the token's limit until it closes.
    const abort = new AbortController();
    // A new token starts from scratch: what the last one saw no longer holds.
    setHealth(null);
    setDenied(false);

    async function connect() {
      let retryMs = HEALTH_RETRY_MS;
      try {
        const headers: Record<string, string> = {};
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        } else {
          headers["X-Swamp-Dashboard-Origin"] = globalThis.location.origin;
        }

        const url = `/api/v1/health/stream?interval=${intervalMs}`;
        const resp = await fetch(url, { headers, signal: abort.signal });

        const outcome = healthStreamOutcome(resp.status);
        if (outcome === "denied") {
          await resp.body?.cancel();
          if (!cancelled) {
            setHealth(null);
            setDenied(true);
          }
          return;
        }

        if (outcome === "ok" && resp.body) {
          setDenied(false);
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let event = "message";

          while (!cancelled) {
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
                  const snapshot = JSON.parse(
                    line.slice(6),
                  ) as HealthSnapshot;
                  setHealth(snapshot);
                } catch {
                  // ignore parse errors
                }
              }
              // A session-ended event precedes the server closing the
              // stream; the reconnect below then learns whether the token
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

      if (!cancelled) {
        retryTimeout = setTimeout(connect, retryMs);
      }
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimeout);
      abort.abort();
    };
  }, [token, intervalMs]);

  return { health, denied };
}

import { useEffect, useState } from "react";
import { useSwamp } from "./SwampProvider";

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

export function useHealthStream(intervalMs = 5000): HealthSnapshot | null {
  const { token } = useSwamp();
  const [health, setHealth] = useState<HealthSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout>;

    async function connect() {
      try {
        const headers: Record<string, string> = {};
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }

        const url = `/api/v1/health/stream?interval=${intervalMs}`;
        const resp = await fetch(url, { headers });

        if (!resp.ok || !resp.body) return;

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const snapshot = JSON.parse(
                  line.slice(6),
                ) as HealthSnapshot;
                setHealth(snapshot);
              } catch {
                // ignore parse errors
              }
            }
          }
        }
      } catch {
        // reconnect after delay
      }

      if (!cancelled) {
        retryTimeout = setTimeout(connect, 5000);
      }
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimeout);
    };
  }, [token, intervalMs]);

  return health;
}

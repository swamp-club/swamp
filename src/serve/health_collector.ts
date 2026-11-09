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

import type { ActiveRunRegistry } from "./active_run_registry.ts";
import type {
  RunMetricsSnapshot,
  RunMetricsTracker,
} from "./run_metrics_tracker.ts";
import type {
  ComponentHealth,
  ComponentHealthChecker,
} from "./component_health_checker.ts";
import type { WorkerSnapshot } from "./worker_gateway.ts";

export interface HealthSnapshotRun {
  readonly runId: string;
  readonly kind: string;
  readonly resourceName: string;
  readonly durationMs: number;
  readonly principalId: string | null;
}

export interface HealthSnapshotSchedule {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly cronExpression: string;
  readonly nextRun: string | null;
  readonly running: boolean;
  readonly queued: number;
  readonly oldestQueuedAt: string | null;
  readonly lastQueueDelayMs: number | null;
  readonly catchUp: HealthScheduleCatchUp | null;
  readonly lastMissed: HealthScheduleMissedFire | null;
}

export interface HealthScheduleCatchUp {
  readonly policy: string;
  readonly maxDelay?: string;
}

export interface HealthScheduleMissedFire {
  readonly fireTime: string;
  readonly count: number;
  readonly saturated?: boolean;
  readonly reason: string;
  readonly caughtUp: boolean;
  readonly detectedAt: string;
}

export interface HealthSnapshotWebhook {
  readonly route: string;
  readonly workflow: string;
  readonly scheme: string;
  /** config and file routes change with a reload; flag routes need a restart */
  readonly source: "config" | "flag" | "file";
  readonly file?: string;
  readonly active: number;
  readonly queued: number;
  readonly oldestQueuedAt: string | null;
  readonly lastQueueDelayMs: number | null;
}

export interface HealthSnapshotRetentionKind {
  readonly kind: string;
  readonly retention: string | null;
  readonly cutoff: string | null;
  readonly lastPassAt: string | null;
  readonly complete: boolean | null;
}

export interface HealthSnapshotRetention {
  readonly automatic: boolean;
  readonly configured: boolean;
  readonly kinds: HealthSnapshotRetentionKind[];
}

export interface RetentionHealthProvider {
  retention(): Promise<HealthSnapshotRetention | null>;
}

export interface HealthSnapshot {
  readonly instanceId: string;
  readonly deploymentMode: string;
  readonly remoteOnly: boolean;
  readonly uptimeMs: number;
  readonly ready: boolean;
  readonly activeRuns: HealthSnapshotRun[];
  readonly metrics: RunMetricsSnapshot;
  readonly workers: WorkerSnapshot[];
  readonly scheduling: {
    readonly enabled: boolean;
    readonly schedules: HealthSnapshotSchedule[];
    readonly timeZone?: string;
  };
  readonly webhooks: HealthSnapshotWebhook[];
  readonly components: ComponentHealth[];
  /** Present when serve was given a retention provider. */
  readonly retention?: HealthSnapshotRetention;
}

export interface ScheduleProvider {
  listSchedules(): Array<{
    readonly workflowId: string;
    readonly workflowName: string;
    readonly cronExpression: string;
    readonly nextRun: Date | null;
  }>;
  isRunning(workflowId: string): boolean;
  queueStatus(workflowId: string): {
    readonly queued: number;
    readonly oldestQueuedAt: string | null;
    readonly lastQueueDelayMs: number | null;
  };
  scheduleStatus(workflowId: string): {
    readonly catchUp: HealthScheduleCatchUp | null;
    readonly lastMissed: HealthScheduleMissedFire | null;
  };
}

export interface WebhookProvider {
  listEndpoints(): ReadonlyArray<{
    readonly route: string;
    readonly workflowIdOrName: string;
    readonly scheme: string;
    readonly source?: "config" | "flag" | "file";
    readonly file?: string;
  }>;
  queueStatus(route: string): {
    readonly active: number;
    readonly queued: number;
    readonly oldestQueuedAt: string | null;
    readonly lastQueueDelayMs: number | null;
  };
}

export interface WorkerProvider {
  workers(): WorkerSnapshot[];
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCollectorDeps {
  readonly instanceId: string;
  readonly deploymentMode: string;
  readonly startedAt: number;
  readonly isReady: () => boolean;
  readonly activeRunRegistry: ActiveRunRegistry | null;
  readonly metricsTracker: RunMetricsTracker;
  readonly componentChecker: ComponentHealthChecker;
  readonly workerProvider: WorkerProvider | null;
  readonly scheduleProvider: ScheduleProvider | null;
  readonly scheduleEnabled: boolean;
  readonly webhookProvider: WebhookProvider | null;
  readonly remoteOnly: boolean;
  readonly retentionProvider?: RetentionHealthProvider | null;
  /**
   * How long, in milliseconds, one collected snapshot is served to every
   * caller before the next call collects again. Defaults to 0: every call
   * collects (callers arriving while a collection runs still share it).
   */
  readonly snapshotMaxAgeMs?: number;
  readonly now?: () => number;
  readonly onHealthTransition?: (
    previous: HealthStatus,
    current: HealthStatus,
  ) => void;
}

export function classifyHealthStatus(
  ready: boolean,
  components: readonly { healthy: boolean }[],
): HealthStatus {
  if (!ready) return "unhealthy";
  if (components.length === 0) return "healthy";
  const allHealthy = components.every((c) => c.healthy);
  if (allHealthy) return "healthy";
  return "degraded";
}

export const RETENTION_HEALTH_READ_TIMEOUT_MS = 2_000;

async function raceRetentionRead<T>(
  read: Promise<T | null>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class HealthCollector {
  readonly #deps: HealthCollectorDeps;
  #inflight: Promise<HealthSnapshot> | null = null;
  #previousStatus: HealthStatus | null = null;
  #cached: { snapshot: HealthSnapshot; collectedAt: number } | null = null;

  constructor(deps: HealthCollectorDeps) {
    this.#deps = deps;
  }

  collect(signal?: AbortSignal): Promise<HealthSnapshot> {
    const now = this.#deps.now ?? (() => performance.now());
    const maxAgeMs = this.#deps.snapshotMaxAgeMs ?? 0;
    if (this.#cached) {
      const age = now() - this.#cached.collectedAt;
      // A negative age means the clock went backwards: treat it as expired.
      if (age >= 0 && age < maxAgeMs) {
        return Promise.resolve(this.#cached.snapshot);
      }
      this.#cached = null;
    }
    if (this.#inflight) {
      return this.#inflight;
    }

    const collectedAt = now();
    const p = this.#buildSnapshot(signal).then((snapshot) => {
      if (maxAgeMs > 0) this.#cached = { snapshot, collectedAt };
      return snapshot;
    }).finally(() => {
      this.#inflight = null;
    });
    this.#inflight = p;
    return p;
  }

  async #buildSnapshot(signal?: AbortSignal): Promise<HealthSnapshot> {
    const now = Date.now();

    const activeRuns: HealthSnapshotRun[] = this.#deps.activeRunRegistry
      ? this.#deps.activeRunRegistry.list().map((run) => ({
        runId: run.runId,
        kind: run.kind,
        resourceName: run.resourceName,
        durationMs: now - run.startedAt.getTime(),
        principalId: run.principalId,
      }))
      : [];

    const metrics = this.#deps.metricsTracker.snapshot();

    const workers = this.#deps.workerProvider?.workers() ?? [];

    const schedules: HealthSnapshotSchedule[] = this.#deps.scheduleProvider
      ? this.#deps.scheduleProvider.listSchedules().map((s) => ({
        workflowId: String(s.workflowId),
        workflowName: s.workflowName,
        cronExpression: s.cronExpression,
        nextRun: s.nextRun?.toISOString() ?? null,
        running: this.#deps.scheduleProvider!.isRunning(String(s.workflowId)),
        ...this.#deps.scheduleProvider!.queueStatus(String(s.workflowId)),
        ...this.#deps.scheduleProvider!.scheduleStatus(String(s.workflowId)),
      }))
      : [];

    const webhooks: HealthSnapshotWebhook[] = this.#deps.webhookProvider
      ? this.#deps.webhookProvider.listEndpoints().map((ep) => ({
        route: ep.route,
        workflow: ep.workflowIdOrName,
        scheme: ep.scheme,
        source: ep.source ?? "config",
        ...(ep.file !== undefined ? { file: ep.file } : {}),
        ...this.#deps.webhookProvider!.queueStatus(ep.route),
      }))
      : [];

    const components = await this.#deps.componentChecker.checkAll(signal);

    // Retention is context, never a health verdict: a failed read leaves it
    // out rather than failing the snapshot.
    // Bounded: a stalled control plane must not hang health probes.
    const retention = this.#deps.retentionProvider
      ? await raceRetentionRead(
        this.#deps.retentionProvider.retention().catch(() => null),
        RETENTION_HEALTH_READ_TIMEOUT_MS,
      )
      : null;

    const ready = this.#deps.isReady();
    const currentStatus = classifyHealthStatus(ready, components);

    if (
      this.#previousStatus !== null &&
      currentStatus !== this.#previousStatus &&
      this.#deps.onHealthTransition
    ) {
      this.#deps.onHealthTransition(this.#previousStatus, currentStatus);
    }
    this.#previousStatus = currentStatus;

    return {
      instanceId: this.#deps.instanceId,
      deploymentMode: this.#deps.deploymentMode,
      remoteOnly: this.#deps.remoteOnly,
      uptimeMs: now - this.#deps.startedAt,
      ready,
      activeRuns,
      metrics,
      workers,
      scheduling: {
        enabled: this.#deps.scheduleEnabled,
        schedules,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      webhooks,
      components,
      ...(retention ? { retention } : {}),
    };
  }
}

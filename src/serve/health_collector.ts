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
}

export interface HealthSnapshotWebhook {
  readonly route: string;
  readonly workflow: string;
  readonly scheme: string;
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
  };
  readonly webhooks: HealthSnapshotWebhook[];
  readonly components: ComponentHealth[];
}

export interface ScheduleProvider {
  listSchedules(): Array<{
    readonly workflowId: string;
    readonly workflowName: string;
    readonly cronExpression: string;
    readonly nextRun: Date | null;
  }>;
  isRunning(workflowId: string): boolean;
}

export interface WebhookProvider {
  listEndpoints(): ReadonlyArray<{
    readonly route: string;
    readonly workflowIdOrName: string;
    readonly scheme: string;
  }>;
}

export interface WorkerProvider {
  workers(): WorkerSnapshot[];
}

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
}

export class HealthCollector {
  readonly #deps: HealthCollectorDeps;
  #inflight: Promise<HealthSnapshot> | null = null;

  constructor(deps: HealthCollectorDeps) {
    this.#deps = deps;
  }

  collect(signal?: AbortSignal): Promise<HealthSnapshot> {
    if (this.#inflight) {
      return this.#inflight;
    }

    const p = this.#buildSnapshot(signal).finally(() => {
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
      }))
      : [];

    const webhooks: HealthSnapshotWebhook[] = this.#deps.webhookProvider
      ? this.#deps.webhookProvider.listEndpoints().map((ep) => ({
        route: ep.route,
        workflow: ep.workflowIdOrName,
        scheme: ep.scheme,
      }))
      : [];

    const components = await this.#deps.componentChecker.checkAll(signal);

    return {
      instanceId: this.#deps.instanceId,
      deploymentMode: this.#deps.deploymentMode,
      remoteOnly: this.#deps.remoteOnly,
      uptimeMs: now - this.#deps.startedAt,
      ready: this.#deps.isReady(),
      activeRuns,
      metrics,
      workers,
      scheduling: {
        enabled: this.#deps.scheduleEnabled,
        schedules,
      },
      webhooks,
      components,
    };
  }
}

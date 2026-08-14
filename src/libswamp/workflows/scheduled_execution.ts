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

/**
 * ScheduledExecutionService is a libswamp application service that
 * orchestrates scheduled workflow execution. It connects:
 * - WorkflowScheduler (domain service — timer lifecycle)
 * - WorkflowWatcher (filesystem observation — live reload)
 * - workflowRun (libswamp operation — execution)
 *
 * Emits typed events as an AsyncIterable for consumer observation.
 */

import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import {
  type ScheduleEntry,
  WorkflowScheduler,
} from "../../domain/workflows/workflow_scheduler.ts";
import { workflowsDir, WorkflowWatcher } from "./watcher.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { WorkflowRunEvent, WorkflowRunInput } from "./run.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  extractFirstStepError,
  type WorkflowRunView,
} from "./workflow_run_view.ts";
import { withSpan } from "../../infrastructure/tracing/mod.ts";

const logger = getSwampLogger(["scheduled-execution"]);

/**
 * Events emitted by the scheduled execution service.
 */
export type ScheduledExecutionEvent =
  | {
    kind: "schedule_registered";
    workflowId: WorkflowId;
    workflowName: string;
    cronExpression: string;
  }
  | {
    kind: "schedule_unregistered";
    workflowId: WorkflowId;
    workflowName: string;
  }
  | {
    kind: "schedule_fired";
    workflowId: WorkflowId;
    workflowName: string;
  }
  | {
    kind: "schedule_skipped";
    workflowId: WorkflowId;
    workflowName: string;
    reason: string;
    dedupSkip?: boolean;
  }
  | {
    kind: "schedule_completed";
    workflowId: WorkflowId;
    workflowName: string;
    runId: string;
  }
  | {
    kind: "schedule_failed";
    workflowId: WorkflowId;
    workflowName: string;
    error: string;
  };

/**
 * Callback for schedule events — consumers provide this to observe
 * scheduled execution lifecycle.
 */
export type ScheduledExecutionEventHandler = (
  event: ScheduledExecutionEvent,
) => void;

/**
 * Dependencies required by the ScheduledExecutionService.
 */
/**
 * Callback that executes a workflow run. Injected by the serve layer
 * so libswamp doesn't depend on serve infrastructure.
 */
export type WorkflowExecutor = (
  input: WorkflowRunInput,
  signal: AbortSignal,
  onEvent: (event: WorkflowRunEvent) => void,
) => Promise<void>;

export interface PendingRunHook {
  enqueue(entry: {
    id: string;
    source: "cron";
    workflowIdOrName: string;
    createdAt: string;
  }): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ActiveRunHook {
  write(runId: string, resourceName: string, runKind: string): void;
  delete(runId: string): void;
}

/**
 * Callback for cross-instance cron fire dedup. Returns true if this
 * instance should execute, false if another instance already claimed
 * the fire slot. When not provided (single-instance mode), all fires
 * proceed unconditionally.
 */
export type CronFireDedupCallback = (
  workflowId: string,
  fireTime: Date,
) => Promise<boolean>;

export interface TriggerOverride {
  readonly schedule?: string;
  readonly inputs?: Record<string, unknown>;
}

export interface ScheduledExecutionDeps {
  workflowRepo: WorkflowRepository;
  repoDir: string;
  executeWorkflow: WorkflowExecutor;
  pendingRunHook?: PendingRunHook;
  activeRunHook?: ActiveRunHook;
  cronFireDedup?: CronFireDedupCallback;
  triggerOverrides?: ReadonlyMap<string, TriggerOverride>;
}

export class ScheduledExecutionService {
  private readonly scheduler: WorkflowScheduler;
  private readonly watcher: WorkflowWatcher;
  private readonly running = new Map<
    WorkflowId,
    { controller: AbortController; runId: string }
  >();
  private readonly workflowNames = new Map<WorkflowId, string>();
  private readonly runQueue: Array<{
    pendingRunId?: string;
    enqueuePromise?: Promise<void>;
    workflowId: WorkflowId;
    workflowName: string;
  }> = [];
  private processing = false;
  private processingPromise: Promise<void> = Promise.resolve();
  private eventHandler: ScheduledExecutionEventHandler | null = null;

  constructor(private readonly deps: ScheduledExecutionDeps) {
    this.scheduler = new WorkflowScheduler();
    this.watcher = new WorkflowWatcher(
      workflowsDir(deps.repoDir),
      deps.workflowRepo,
      (workflowId, schedule, workflowName) =>
        this.handleScheduleChange(workflowId, schedule, workflowName),
    );
  }

  /**
   * Starts the scheduled execution service:
   * 1. Scans all existing workflows for schedules
   * 2. Applies trigger overrides from serve config
   * 3. Starts the filesystem watcher for live reload
   * 4. Starts the scheduler to fire cron jobs
   */
  async start(
    onEvent?: ScheduledExecutionEventHandler,
  ): Promise<void> {
    this.eventHandler = onEvent ?? null;

    // Phase 1: scan existing workflows and register built-in schedules
    await this.watcher.scanExisting();

    // Phase 2: apply trigger overrides — adds schedules to unscheduled
    // workflows and replaces schedules on already-registered ones
    await this.applyTriggerOverrides();

    // Start the scheduler — cron jobs begin firing
    this.scheduler.start((workflowId, fireTime) =>
      this.handleFire(workflowId, fireTime)
    );

    // Start watching for changes
    await this.watcher.start();

    logger.info("Scheduled execution service started with {count} schedules", {
      count: this.scheduler.size,
    });
  }

  /**
   * Stops the service: aborts in-flight runs, stops watcher and scheduler.
   */
  async stop(): Promise<void> {
    await this.watcher.stop();
    this.scheduler.stop();

    // Clear the queue so no new runs start after current one finishes
    this.runQueue.length = 0;

    // Abort all in-flight runs
    for (const [workflowId, entry] of this.running) {
      logger.info(
        "Aborting in-flight scheduled run for workflow {workflowId}",
        { workflowId },
      );
      entry.controller.abort();
    }

    // Drain the processing promise — runs exit quickly after abort
    await this.processingPromise;

    this.running.clear();
    this.workflowNames.clear();
    this.eventHandler = null;

    logger.info("Scheduled execution service stopped");
  }

  /**
   * Returns all registered schedules and their next fire times.
   */
  listSchedules(): ScheduleEntry[] {
    return this.scheduler.listSchedules();
  }

  /**
   * Returns whether a workflow is currently running from a scheduled trigger.
   */
  isRunning(workflowId: WorkflowId): boolean {
    return this.running.has(workflowId);
  }

  /**
   * Cancels a scheduled run by workflow ID. Returns true if found and aborted.
   */
  cancelRun(workflowId: string): boolean {
    const id = workflowId as WorkflowId;
    const entry = this.running.get(id);
    if (!entry) {
      return false;
    }
    logger.info`Cancelling scheduled run for workflow ${workflowId}`;
    entry.controller.abort(new Error("cancelled by user"));
    return true;
  }

  /**
   * Cancels a scheduled run by run ID (reverse lookup). Used by the REST
   * cancel endpoint which receives a run ID, not a workflow ID.
   * Returns true if found and aborted.
   */
  cancelByRunId(runId: string): boolean {
    for (const [workflowId, entry] of this.running) {
      if (entry.runId === runId) {
        logger
          .info`Cancelling scheduled run ${runId} for workflow ${workflowId}`;
        entry.controller.abort(new Error("cancelled by user"));
        return true;
      }
    }
    return false;
  }

  /**
   * Cancels all scheduled runs. Returns the number of runs cancelled.
   */
  cancelAllRuns(): number {
    let count = 0;
    for (const [workflowId, entry] of this.running) {
      logger.info`Cancelling scheduled run for workflow ${workflowId}`;
      entry.controller.abort(new Error("cancelled by user"));
      count++;
    }
    return count;
  }

  enqueueForReplay(entry: {
    pendingRunId: string;
    workflowIdOrName: string;
  }): void {
    this.runQueue.push({
      pendingRunId: entry.pendingRunId,
      workflowId: entry.workflowIdOrName as WorkflowId,
      workflowName: entry.workflowIdOrName,
    });
    if (!this.processing) {
      this.processingPromise = this.processQueue();
    }
  }

  private resolveSchedule(
    workflowName: string,
    builtInSchedule: string | null,
  ): string | null {
    const override = this.deps.triggerOverrides?.get(workflowName);
    if (override?.schedule !== undefined) {
      return override.schedule;
    }
    return builtInSchedule;
  }

  private handleScheduleChange(
    workflowId: WorkflowId,
    schedule: string | null,
    workflowName: string,
  ): void {
    const effective = this.resolveSchedule(workflowName, schedule);
    if (effective) {
      this.scheduler.register(workflowId, effective);
      this.workflowNames.set(workflowId, workflowName);
      this.emit({
        kind: "schedule_registered",
        workflowId,
        workflowName,
        cronExpression: effective,
      });
      const isOverride =
        this.deps.triggerOverrides?.get(workflowName)?.schedule !== undefined;
      logger.info(
        isOverride
          ? "Registered schedule for workflow {name}: {schedule} (serve.yaml override)"
          : "Registered schedule for workflow {name}: {schedule}",
        { name: workflowName, schedule: effective },
      );
    } else {
      this.scheduler.unregister(workflowId);
      const name = this.workflowNames.get(workflowId) ?? workflowName;
      this.workflowNames.delete(workflowId);
      this.emit({
        kind: "schedule_unregistered",
        workflowId,
        workflowName: name,
      });
      logger.info("Unregistered schedule for workflow {name}", { name });
    }
  }

  private async applyTriggerOverrides(): Promise<void> {
    const overrides = this.deps.triggerOverrides;
    if (!overrides || overrides.size === 0) return;

    const registeredNames = new Set(this.workflowNames.values());

    for (const [workflowName, override] of overrides) {
      if (!override.schedule) {
        if (!registeredNames.has(workflowName)) {
          logger.warn(
            "Trigger override for workflow {name} has only inputs but workflow has no schedule — override is a no-op",
            { name: workflowName },
          );
        }
        continue;
      }

      if (registeredNames.has(workflowName)) continue;

      const workflow = await this.deps.workflowRepo.findByName(workflowName);
      if (!workflow) {
        logger.warn(
          "Trigger override for unknown workflow {name} — skipping",
          { name: workflowName },
        );
        continue;
      }

      this.handleScheduleChange(workflow.id, null, workflow.name);
    }
  }

  private async handleFire(
    workflowId: WorkflowId,
    fireTime: Date,
  ): Promise<void> {
    const workflowName = this.workflowNames.get(workflowId) ?? workflowId;

    // Overlap prevention — skip if this specific workflow is already running.
    // Replayed runs are keyed by name (not UUID), so check both.
    if (
      this.running.has(workflowId) ||
      this.running.has(workflowName as WorkflowId)
    ) {
      this.emit({
        kind: "schedule_skipped",
        workflowId,
        workflowName,
        reason: "Previous run still in progress",
      });
      logger.warn(
        "Skipping scheduled run for {name}: previous run still in progress",
        { name: workflowName },
      );
      return;
    }

    // Cross-instance dedup — race to claim this fire slot via the
    // control-plane store. If another instance won, skip silently.
    if (this.deps.cronFireDedup) {
      try {
        const claimed = await this.deps.cronFireDedup(workflowId, fireTime);
        if (!claimed) {
          this.emit({
            kind: "schedule_skipped",
            workflowId,
            workflowName,
            reason: "Claimed by another instance",
            dedupSkip: true,
          });
          return;
        }
      } catch (err: unknown) {
        logger.warn(
          "Cron fire dedup failed for {name}, proceeding with execution: {error}",
          {
            name: workflowName,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    this.emit({
      kind: "schedule_fired",
      workflowId,
      workflowName,
    });
    logger.info("Firing scheduled run for workflow {name}", {
      name: workflowName,
    });

    // Queue the run — workflows execute one at a time to avoid lock
    // contention. Before scheduling, each workflow ran as a separate
    // process via systemd timers; serializing preserves that behavior.
    let pendingRunId: string | undefined;
    let enqueuePromise: Promise<void> | undefined;
    if (this.deps.pendingRunHook) {
      pendingRunId = crypto.randomUUID();
      enqueuePromise = this.deps.pendingRunHook.enqueue({
        id: pendingRunId,
        source: "cron",
        workflowIdOrName: workflowName,
        createdAt: new Date().toISOString(),
      });
    }
    this.runQueue.push({
      pendingRunId,
      enqueuePromise,
      workflowId,
      workflowName,
    });
    if (!this.processing) {
      this.processingPromise = this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.runQueue.length > 0) {
        const { pendingRunId, enqueuePromise, workflowId, workflowName } = this
          .runQueue.shift()!;
        if (pendingRunId && this.deps.pendingRunHook) {
          if (enqueuePromise) await enqueuePromise;
          await this.deps.pendingRunHook.delete(pendingRunId);
        }
        await this.executeWorkflow(workflowId, workflowName);
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeWorkflow(
    workflowId: WorkflowId,
    workflowName: string,
  ): Promise<void> {
    const controller = new AbortController();
    // runId starts empty until the "started" event arrives with the real ID.
    // During this narrow window cancelByRunId() cannot match this run;
    // the window closes as soon as executeWorkflow emits "started".
    this.running.set(workflowId, { controller, runId: "" });
    let runId = "";

    try {
      let completedRun: WorkflowRunView | undefined;
      let streamError: string | undefined;

      const override = this.deps.triggerOverrides?.get(workflowName);

      await withSpan(
        "swamp.scheduled.fire",
        { "workflow.id": String(workflowId), "workflow.name": workflowName },
        async (_span) => {
          await this.deps.executeWorkflow(
            {
              workflowIdOrName: workflowName,
              inputs: override?.inputs,
            },
            controller.signal,
            (event) => {
              if (event.kind === "started") {
                runId = event.runId;
                this.running.set(workflowId, { controller, runId });
                this.deps.activeRunHook?.write(
                  runId,
                  workflowName,
                  "workflow-run",
                );
              }
              if (event.kind === "completed") {
                completedRun = event.run;
              }
              if (event.kind === "cancelled") {
                completedRun = event.run;
              }
              if (event.kind === "error") {
                streamError = event.error.message;
              }
            },
          );
        },
      );

      if (completedRun?.status === "succeeded") {
        this.emit({
          kind: "schedule_completed",
          workflowId,
          workflowName,
          runId,
        });
        logger.info(
          "Scheduled run completed for workflow {name} (run: {runId})",
          { name: workflowName, runId },
        );
      } else if (completedRun?.status === "cancelled") {
        const message = "workflow was cancelled";
        this.emit({
          kind: "schedule_failed",
          workflowId,
          workflowName,
          error: message,
        });
        logger.warn(
          "Scheduled run cancelled for workflow {name}: {error}",
          { name: workflowName, error: message },
        );
      } else {
        const message = completedRun
          ? extractFirstStepError(completedRun)
          : streamError ?? "workflow did not complete";
        this.emit({
          kind: "schedule_failed",
          workflowId,
          workflowName,
          error: message,
        });
        logger.error(
          "Scheduled run failed for workflow {name}: {error}",
          { name: workflowName, error: message },
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        logger.info("Scheduled run aborted for workflow {name}", {
          name: workflowName,
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        kind: "schedule_failed",
        workflowId,
        workflowName,
        error: message,
      });
      logger.error(
        "Scheduled run failed for workflow {name}: {error}",
        { name: workflowName, error: message },
      );
    } finally {
      this.running.delete(workflowId);
      if (runId) {
        this.deps.activeRunHook?.delete(runId);
      }
    }
  }

  private emit(event: ScheduledExecutionEvent): void {
    this.eventHandler?.(event);
  }
}

/**
 * Normalizes a fire time to a deterministic key component shared
 * across all instances. Truncates to the second and formats as
 * ISO 8601 UTC without milliseconds, with colons replaced by
 * hyphens for Windows filesystem compatibility
 * (e.g. "2026-08-01T00-00-00Z").
 */
export function normalizeFireTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

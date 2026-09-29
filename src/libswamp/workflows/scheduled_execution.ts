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
 * How long a drain waits for fires still claiming their slot. A claim is a
 * single control-plane write, so this bounds shutdown against a hung store
 * without depending on the drain timeout, which may be 0.
 */
const FIRE_SETTLE_TIMEOUT_MS = 5_000;

/** Resolves when `promise` settles or `timeoutMs` elapses, whichever is first. */
async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(() => {}, () => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
    /** ISO-8601 cron fire time. */
    fireTime: string;
  }
  | {
    kind: "schedule_skipped";
    workflowId: WorkflowId;
    workflowName: string;
    reason: string;
    dedupSkip?: boolean;
    /** ISO-8601 cron fire time. */
    fireTime: string;
  }
  | {
    /** A run began executing; runId is known from here on. */
    kind: "schedule_started";
    workflowId: WorkflowId;
    workflowName: string;
    runId: string;
    /** ISO-8601 cron fire time; unset for a run replayed after a restart. */
    fireTime?: string;
    replayed: boolean;
  }
  | {
    /** Authorization refused the run; it never started. */
    kind: "schedule_denied";
    workflowId: WorkflowId;
    workflowName: string;
    reason: string;
    fireTime?: string;
    replayed: boolean;
  }
  | {
    kind: "schedule_completed";
    workflowId: WorkflowId;
    workflowName: string;
    runId: string;
  }
  | {
    kind: "schedule_suspended";
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

/** What the scheduler asks before it starts a run. */
export interface ScheduledRunRequest {
  readonly workflowName: string;
  /** Unset for a run replayed after a restart. */
  readonly fireTime?: Date;
  readonly replayed: boolean;
}

export interface ScheduledRunAuthorization {
  readonly allowed: boolean;
  /** The workflow to run: exactly the value authorization decided on. */
  readonly workflowIdOrName: string;
  readonly reason?: string;
}

/**
 * Callback that authorizes each run at execution time, so queued and
 * replayed runs are both checked against the current policy. Injected by
 * the serve layer; when absent every run proceeds.
 */
export type ScheduledRunAuthorizer = (
  request: ScheduledRunRequest,
) => Promise<ScheduledRunAuthorization>;

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
  /** Recorded on every run as `initiatedBy` (the scheduler's principal). */
  initiatedBy?: string;
  authorizeRun?: ScheduledRunAuthorizer;
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
    fireTime?: Date;
    replayed: boolean;
  }> = [];
  private processing = false;
  private processingPromise: Promise<void> = Promise.resolve();
  private draining = false;
  private stopped = false;
  /** Fires still in handleFire, e.g. waiting on the cron dedup claim. */
  private readonly inFlightFires = new Set<Promise<void>>();
  private eventHandler: ScheduledExecutionEventHandler | null = null;
  private triggerOverrides: ReadonlyMap<string, TriggerOverride>;

  constructor(private readonly deps: ScheduledExecutionDeps) {
    this.triggerOverrides = deps.triggerOverrides ?? new Map();
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
    this.scheduler.start((workflowId, fireTime) => {
      const fire: Promise<void> = this.handleFire(workflowId, fireTime)
        .finally(() => this.inFlightFires.delete(fire));
      this.inFlightFires.add(fire);
      return fire;
    });

    // Start watching for changes
    await this.watcher.start();

    logger.info("Scheduled execution service started with {count} schedules", {
      count: this.scheduler.size,
    });
  }

  /**
   * Begin shutdown: stop the watcher and scheduler, drop queued runs (their
   * pending-run entries stay for the next boot to replay), and wait up to
   * `timeoutMs` for the in-flight run to finish. A timeout of 0 returns at
   * once. Call {@link stop} afterwards to abort what is left.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    await this.watcher.stop();
    this.scheduler.stop();
    // Dropped entries' pending-run writes are observed here, since
    // processQueue will never await them.
    const dropped = this.runQueue.splice(0);
    const writes = await Promise.allSettled(
      dropped.map((entry) => entry.enqueuePromise),
    );
    for (const write of writes) {
      if (write.status === "rejected") {
        logger.warn("Pending-run write for a queued cron run failed: {error}", {
          error: write.reason instanceof Error
            ? write.reason.message
            : String(write.reason),
        });
      }
    }
    // A fire that claimed its slot is run by no peer, so shutdown waits for
    // it to be recorded for replay even when the drain timeout is 0.
    await Promise.all([
      settleWithin(
        Promise.allSettled([...this.inFlightFires]),
        FIRE_SETTLE_TIMEOUT_MS,
      ),
      timeoutMs > 0
        ? settleWithin(this.processingPromise, timeoutMs)
        : Promise.resolve(),
    ]);
  }

  /**
   * Stops the service: aborts in-flight runs, stops watcher and scheduler.
   */
  async stop(): Promise<void> {
    this.stopped = true;
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
   * Re-scans all workflows and registers any new schedules.
   * Called during hot reload after extension workflow directories are updated.
   */
  async rescanWorkflows(): Promise<void> {
    await this.watcher.scanExisting();
  }

  /**
   * Returns all registered schedules and their next fire times.
   */
  listSchedules(): Array<ScheduleEntry & { workflowName: string }> {
    return this.scheduler.listSchedules().map((entry) => ({
      ...entry,
      workflowName: this.workflowNames.get(entry.workflowId) ??
        entry.workflowId,
    }));
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
   * Returns true if found and aborted. `reason` becomes the run's
   * `cancel_reason`.
   */
  cancelByRunId(runId: string, reason = "cancelled by user"): boolean {
    for (const [workflowId, entry] of this.running) {
      if (entry.runId === runId) {
        logger
          .info`Cancelling scheduled run ${runId} for workflow ${workflowId}`;
        entry.controller.abort(new Error(reason));
        return true;
      }
    }
    return false;
  }

  /**
   * Cancels all scheduled runs. Returns the number of runs cancelled.
   */
  cancelAllRuns(reason = "cancelled by user"): number {
    let count = 0;
    for (const [workflowId, entry] of this.running) {
      logger.info`Cancelling scheduled run for workflow ${workflowId}`;
      entry.controller.abort(new Error(reason));
      count++;
    }
    return count;
  }

  enqueueForReplay(entry: {
    pendingRunId: string;
    workflowIdOrName: string;
  }): void {
    // The pending entry stays in the run tracker for the next boot to replay.
    if (this.draining) return;
    this.runQueue.push({
      pendingRunId: entry.pendingRunId,
      workflowId: entry.workflowIdOrName as WorkflowId,
      workflowName: entry.workflowIdOrName,
      replayed: true,
    });
    if (!this.processing) {
      this.processingPromise = this.processQueue();
    }
  }

  private resolveSchedule(
    workflowName: string,
    builtInSchedule: string | null,
  ): string | null {
    const override = this.triggerOverrides.get(workflowName);
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
        this.triggerOverrides.get(workflowName)?.schedule !== undefined;
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
    const overrides = this.triggerOverrides;
    if (overrides.size === 0) return;

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

  async updateTriggerOverrides(
    newOverrides: ReadonlyMap<string, TriggerOverride>,
  ): Promise<number> {
    const oldOverrides = this.triggerOverrides;
    this.triggerOverrides = newOverrides;
    let changed = 0;

    // Removed overrides: fall back to built-in schedule
    for (const [workflowName] of oldOverrides) {
      if (newOverrides.has(workflowName)) continue;

      const workflowId = this.findWorkflowIdByName(workflowName);
      if (workflowId) {
        const workflow = await this.deps.workflowRepo.findByName(workflowName);
        this.handleScheduleChange(
          workflowId,
          workflow?.schedule ?? null,
          workflowName,
        );
        changed++;
      }
    }

    // Added or changed overrides
    for (const [workflowName, newOverride] of newOverrides) {
      const oldOverride = oldOverrides.get(workflowName);

      if (
        oldOverride?.schedule === newOverride.schedule &&
        JSON.stringify(oldOverride?.inputs) ===
          JSON.stringify(newOverride.inputs)
      ) {
        continue;
      }

      const workflowId = this.findWorkflowIdByName(workflowName);
      if (workflowId) {
        const workflow = await this.deps.workflowRepo.findByName(workflowName);
        this.handleScheduleChange(
          workflowId,
          workflow?.schedule ?? null,
          workflowName,
        );
        changed++;
      } else if (newOverride.schedule) {
        const workflow = await this.deps.workflowRepo.findByName(workflowName);
        if (workflow) {
          this.handleScheduleChange(workflow.id, null, workflow.name);
          changed++;
        } else {
          logger.warn(
            "Trigger override for unknown workflow {name} — skipping",
            { name: workflowName },
          );
        }
      }
    }

    if (changed > 0) {
      logger.info(
        "Updated trigger overrides: {changed} schedule(s) changed",
        { changed },
      );
    }

    return changed;
  }

  private findWorkflowIdByName(name: string): WorkflowId | undefined {
    for (const [id, n] of this.workflowNames) {
      if (n === name) return id;
    }
    return undefined;
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
        fireTime: fireTime.toISOString(),
      });
      logger.warn(
        "Skipping scheduled run for {name}: previous run still in progress",
        { name: workflowName },
      );
      return;
    }

    // A draining service starts no new runs; checked again after the dedup
    // await, which can span the start of a drain.
    if (this.draining) return;

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
            fireTime: fireTime.toISOString(),
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
    if (this.draining) {
      // This instance may have claimed the fire slot, so peers skip it.
      // Record the fire for the next boot to replay instead of dropping it
      // cluster-wide.
      await this.recordForReplay(workflowName);
      return;
    }

    this.emit({
      kind: "schedule_fired",
      workflowId,
      workflowName,
      fireTime: fireTime.toISOString(),
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
      fireTime,
      replayed: false,
    });
    if (!this.processing) {
      this.processingPromise = this.processQueue();
    }
  }

  private async recordForReplay(workflowName: string): Promise<void> {
    if (!this.deps.pendingRunHook) return;
    try {
      await this.deps.pendingRunHook.enqueue({
        id: crypto.randomUUID(),
        source: "cron",
        workflowIdOrName: workflowName,
        createdAt: new Date().toISOString(),
      });
      logger.info(
        "Recorded cron fire for {name} for replay after shutdown",
        { name: workflowName },
      );
    } catch (err: unknown) {
      logger.warn("Failed to record cron fire for {name}: {error}", {
        name: workflowName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.runQueue.length > 0) {
        const entry = this.runQueue.shift()!;
        const { pendingRunId, enqueuePromise } = entry;
        if (enqueuePromise) await enqueuePromise;
        // A drain that began while this entry was dequeued leaves it pending
        // for the next boot to replay rather than starting it now.
        if (this.draining) break;
        if (pendingRunId && this.deps.pendingRunHook) {
          await this.deps.pendingRunHook.delete(pendingRunId);
        }
        await this.executeWorkflow(entry);
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeWorkflow(entry: {
    workflowId: WorkflowId;
    workflowName: string;
    fireTime?: Date;
    replayed: boolean;
  }): Promise<void> {
    const { workflowId, workflowName, replayed } = entry;
    const fireTime = entry.fireTime?.toISOString();
    const authorization = await this.authorize(entry);
    if (!authorization.allowed) {
      this.emit({
        kind: "schedule_denied",
        workflowId,
        workflowName,
        reason: authorization.reason ?? "denied",
        fireTime,
        replayed,
      });
      logger.warn(
        "Scheduled run refused for workflow {name}: {reason}",
        { name: workflowName, reason: authorization.reason ?? "denied" },
      );
      return;
    }

    const controller = new AbortController();
    // runId starts empty until the "started" event arrives with the real ID.
    // During this narrow window cancelByRunId() cannot match this run;
    // the window closes as soon as executeWorkflow emits "started".
    this.running.set(workflowId, { controller, runId: "" });
    // stop() may have swept `running` while this run was still dequeuing.
    if (this.stopped) controller.abort();
    let runId = "";

    try {
      let completedRun: WorkflowRunView | undefined;
      let streamError: string | undefined;
      let suspended = false;

      const override = this.triggerOverrides.get(workflowName);

      await withSpan(
        "swamp.scheduled.fire",
        { "workflow.id": String(workflowId), "workflow.name": workflowName },
        async (_span) => {
          await this.deps.executeWorkflow(
            {
              workflowIdOrName: authorization.workflowIdOrName,
              inputs: override?.inputs,
              initiatedBy: this.deps.initiatedBy,
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
                this.emit({
                  kind: "schedule_started",
                  workflowId,
                  // The workflow authorization decided on, which is running.
                  workflowName: authorization.workflowIdOrName,
                  runId,
                  fireTime,
                  replayed,
                });
              }
              if (event.kind === "completed") {
                completedRun = event.run;
              }
              if (event.kind === "cancelled") {
                completedRun = event.run;
              }
              if (event.kind === "suspended") {
                suspended = true;
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
      } else if (suspended) {
        this.emit({
          kind: "schedule_suspended",
          workflowId,
          workflowName,
          runId,
        });
        logger.info(
          "Scheduled run suspended awaiting approval for workflow {name} (run: {runId})",
          { name: workflowName, runId },
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

  /** Never throws: an authorizer failure refuses the run. */
  private async authorize(entry: {
    workflowName: string;
    fireTime?: Date;
    replayed: boolean;
  }): Promise<ScheduledRunAuthorization> {
    if (!this.deps.authorizeRun) {
      return { allowed: true, workflowIdOrName: entry.workflowName };
    }
    try {
      return await this.deps.authorizeRun({
        workflowName: entry.workflowName,
        fireTime: entry.fireTime,
        replayed: entry.replayed,
      });
    } catch (error) {
      return {
        allowed: false,
        workflowIdOrName: entry.workflowName,
        reason: `authorization_error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
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

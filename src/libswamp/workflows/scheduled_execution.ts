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

import { withoutVaultAccess } from "../../domain/vaults/run_vault_access.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import {
  isSchedulePauseActiveAt,
  type SchedulePause,
  type SchedulePauseRepository,
} from "../../domain/workflows/schedule_pause.ts";
import {
  effectiveSchedule,
  type ScheduleEntry,
  WorkflowScheduler,
} from "../../domain/workflows/workflow_scheduler.ts";
import {
  CATCH_UP_TAG,
  evaluateMissedFires,
  type MissedFires,
  type ScheduleCatchUp,
  SCHEDULED_FOR_TAG,
} from "../../domain/workflows/schedule_catch_up.ts";
import {
  advanceScheduleState,
  type MissedFire,
  type MissedFireReason,
  type ScheduleState,
  type ScheduleStateRepository,
} from "../../domain/workflows/schedule_state.ts";
import { WorkflowWatcher } from "./watcher.ts";
import { workflowsDirFor } from "./broken_workflow.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { WorkflowRunEvent, WorkflowRunInput } from "./run.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  extractFirstStepError,
  type WorkflowRunView,
} from "./workflow_run_view.ts";
import { runDetached, withRootSpan } from "../../infrastructure/tracing/mod.ts";

const logger = getSwampLogger(["scheduled-execution"]);

/**
 * how long a drain waits for a fire's claim and the state write that settles
 * it; fixed, because the drain timeout may be 0
 */
const FIRE_SETTLE_TIMEOUT_MS = 15_000;

/** run history is read only at startup, so a slow store must not hold a leader */
const RUN_HISTORY_TIMEOUT_MS = 5_000;

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
    fireTime: string;
    catchUp?: boolean;
  }
  | {
    kind: "schedule_missed";
    workflowId: WorkflowId;
    workflowName: string;
    /** the most recent slot missed */
    fireTime: string;
    oldestFireTime: string;
    missedCount: number;
    saturated: boolean;
    caughtUp: boolean;
  }
  | {
    kind: "schedule_skipped";
    workflowId: WorkflowId;
    workflowName: string;
    reason: string;
    dedupSkip?: boolean;
    paused?: {
      readonly reason?: string;
      readonly pausedBy: string;
      readonly until?: string;
    };
    fireTime?: string;
    replayed?: boolean;
  }
  | {
    kind: "schedule_started";
    workflowId: WorkflowId;
    workflowName: string;
    runId: string;
    fireTime?: string;
    replayed: boolean;
    queueDelayMs?: number;
    catchUp?: boolean;
  }
  | {
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

export type ScheduledExecutionEventHandler = (
  event: ScheduledExecutionEvent,
) => void;

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
 * returns true if this instance should execute, false if another already
 * claimed the fire slot; without it all fires proceed
 */
export type CronFireDedupCallback = (
  workflowId: string,
  fireTime: Date,
) => Promise<boolean>;

export interface ScheduledRunRequest {
  readonly workflowName: string;
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
  readonly catchUp?: ScheduleCatchUp;
}

export interface ScheduledExecutionDeps {
  workflowRepo: WorkflowRepository;
  repoDir: string;
  executeWorkflow: WorkflowExecutor;
  pendingRunHook?: PendingRunHook;
  activeRunHook?: ActiveRunHook;
  cronFireDedup?: CronFireDedupCallback;
  triggerOverrides?: ReadonlyMap<string, TriggerOverride>;
  initiatedBy?: string;
  authorizeRun?: ScheduledRunAuthorizer;
  /**
   * The schedule pauses checked before each fire, and before each replayed
   * cron run starts; a paused workflow's fire is skipped. When absent no
   * schedule is ever paused.
   */
  schedulePauses?: SchedulePauseRepository;
  /**
   * Each schedule's watermark and last missed fire. When absent nothing is
   * recorded and catchUpMissedFires does nothing.
   */
  scheduleState?: ScheduleStateRepository;
  /**
   * The latest swamp.trigger.scheduledFor slot recorded by a run the scheduler
   * started, so a slot whose watermark write failed is not caught up again
   */
  latestScheduledSlot?: (workflowId: WorkflowId) => Promise<Date | null>;
  /**
   * How many scheduled runs may be in flight at once. Different workflows run
   * together up to this limit; a workflow never overlaps itself. Defaults to
   * 1: one scheduled run at a time, in fire order.
   */
  maxConcurrentRuns?: number;
  now?: () => number;
}

export interface ScheduleQueueStatus {
  readonly queued: number;
  readonly oldestQueuedAt: string | null;
  readonly lastQueueDelayMs: number | null;
}

interface QueuedRun {
  pendingRunId?: string;
  enqueuePromise?: Promise<void>;
  workflowId: WorkflowId;
  workflowName: string;
  fireTime?: Date;
  enqueuedAt: number;
  replayed: boolean;
  catchUp?: boolean;
}

type FireOutcome =
  | "queued"
  | "paused"
  | "overlap"
  | "claimed_elsewhere"
  | "dropped";

export interface ScheduleStatus {
  readonly catchUp: ScheduleCatchUp | null;
  readonly lastMissed: MissedFire | null;
}

export class ScheduledExecutionService {
  private readonly scheduler: WorkflowScheduler;
  private readonly watcher: WorkflowWatcher;
  private readonly running = new Map<
    WorkflowId,
    { controller: AbortController; runId: string }
  >();
  private readonly workflowNames = new Map<WorkflowId, string>();
  private readonly runQueue: QueuedRun[] = [];
  private readonly maxConcurrentRuns: number;
  private readonly now: () => number;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly claimed = new Set<string>();
  private readonly lastQueueDelayMs = new Map<string, number>();
  private draining = false;
  private stopped = false;
  private readonly inFlightFires = new Set<Promise<void>>();
  private eventHandler: ScheduledExecutionEventHandler | null = null;
  private triggerOverrides: ReadonlyMap<string, TriggerOverride>;
  /**
   * The pause each workflow had at its last successful read, used when the
   * pause store cannot be read, so a flaky store neither runs a paused
   * workflow nor skips an unpaused one.
   */
  private readonly lastPauseRead = new Map<WorkflowId, SchedulePause | null>();
  private readonly cronExpressions = new Map<WorkflowId, string>();
  private readonly builtInCatchUp = new Map<WorkflowId, ScheduleCatchUp>();
  private readonly scheduleStates = new Map<WorkflowId, ScheduleState>();
  private readonly stateWrites = new Set<Promise<void>>();
  /**
   * the stored state read just before this process first settled one of a
   * workflow's fires, and that fire's slot: the catch-up pass reaches no further
   * than a slot already fired here, nor back past what was stored before it
   */
  private readonly firstOwnFire = new Map<
    WorkflowId,
    {
      /** undefined until that fire has settled, or when it could not read */
      prior: ScheduleState | null | undefined;
      readonly slot: Date;
    }
  >();
  private catchUpPassed = false;
  /** registrations before this are the boot scan, which keeps watermarks */
  private started = false;

  constructor(private readonly deps: ScheduledExecutionDeps) {
    this.triggerOverrides = deps.triggerOverrides ?? new Map();
    this.maxConcurrentRuns = Math.max(1, deps.maxConcurrentRuns ?? 1);
    this.now = deps.now ?? Date.now;
    this.scheduler = new WorkflowScheduler();
    this.watcher = new WorkflowWatcher(
      workflowsDirFor(deps.repoDir),
      deps.workflowRepo,
      (workflowId, schedule, workflowName, catchUp) =>
        this.handleScheduleChange(
          workflowId,
          schedule,
          workflowName,
          catchUp,
        ),
    );
  }

  async start(
    onEvent?: ScheduledExecutionEventHandler,
  ): Promise<void> {
    this.eventHandler = onEvent ?? null;

    await this.watcher.scanExisting();

    await this.applyTriggerOverrides();

    await this.loadScheduleStates();
    this.started = true;

    // Start the scheduler — cron jobs begin firing. WorkflowScheduler arms
    // each job's timer detached, so a fire never joins this caller's trace.
    this.scheduler.start(async (workflowId, fireTime) => {
      await this.trackedFire(workflowId, fireTime);
    });

    // Start watching for changes. Detached: serve starts this service inside
    // the never-ending swamp.cli span, and a reload must not join that trace.
    await runDetached(() => this.watcher.start());

    logger.info("Scheduled execution service started with {count} schedules", {
      count: this.scheduler.size,
    });
  }

  /**
   * stops the watcher and scheduler, drops queued runs (their pending-run entries
   * stay for the next boot to replay) and waits up to timeoutMs for in-flight
   * runs; 0 returns at once. Call stop afterwards to abort what is left.
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
        Promise.allSettled([...this.inFlightFires, ...this.stateWrites]),
        FIRE_SETTLE_TIMEOUT_MS,
      ),
      timeoutMs > 0
        ? settleWithin(Promise.allSettled([...this.inFlight]), timeoutMs)
        : Promise.resolve(),
    ]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.watcher.stop();
    this.scheduler.stop();

    this.runQueue.length = 0;

    for (const [workflowId, entry] of this.running) {
      logger.info(
        "Aborting in-flight scheduled run for workflow {workflowId}",
        { workflowId },
      );
      entry.controller.abort();
    }

    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    await settleWithin(
      Promise.allSettled([...this.stateWrites]),
      FIRE_SETTLE_TIMEOUT_MS,
    );

    this.running.clear();
    this.workflowNames.clear();
    this.eventHandler = null;

    logger.info("Scheduled execution service stopped");
  }

  async rescanWorkflows(): Promise<void> {
    await this.watcher.scanExisting();
  }

  getTriggerOverride(workflowName: string): TriggerOverride | undefined {
    return this.triggerOverrides.get(workflowName);
  }

  getTriggerOverrides(): ReadonlyMap<string, TriggerOverride> {
    return this.triggerOverrides;
  }

  listSchedules(): Array<ScheduleEntry & { workflowName: string }> {
    return this.scheduler.listSchedules().map((entry) => ({
      ...entry,
      workflowName: this.workflowNames.get(entry.workflowId) ??
        entry.workflowId,
    }));
  }

  isRunning(workflowId: WorkflowId): boolean {
    return this.running.has(workflowId);
  }

  queueStatus(workflowId: WorkflowId): ScheduleQueueStatus {
    const name = this.workflowNames.get(workflowId) ?? workflowId;
    const waiting = this.runQueue.filter((entry) =>
      entry.workflowId === workflowId || entry.workflowName === name
    );
    const oldest = waiting.reduce<number | undefined>((min, entry) => {
      const at = entry.fireTime?.getTime() ?? entry.enqueuedAt;
      return min === undefined || at < min ? at : min;
    }, undefined);
    return {
      queued: waiting.length,
      oldestQueuedAt: oldest === undefined
        ? null
        : new Date(oldest).toISOString(),
      lastQueueDelayMs: this.lastQueueDelayMs.get(name) ?? null,
    };
  }

  scheduleStatus(workflowId: WorkflowId): ScheduleStatus {
    const name = this.workflowNames.get(workflowId) ?? workflowId;
    return {
      catchUp: this.resolveCatchUp(workflowId, name) ?? null,
      lastMissed: this.scheduleStates.get(workflowId)?.lastMissed ?? null,
    };
  }

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
      enqueuedAt: this.now(),
      replayed: true,
    });
    this.processQueue();
  }

  private resolveSchedule(
    workflowName: string,
    builtInSchedule: string | null,
  ): string | null {
    return effectiveSchedule(
      builtInSchedule,
      this.triggerOverrides.get(workflowName)?.schedule,
    );
  }

  private resolveCatchUp(
    workflowId: WorkflowId,
    workflowName: string,
  ): ScheduleCatchUp | undefined {
    return this.triggerOverrides.get(workflowName)?.catchUp ??
      this.builtInCatchUp.get(workflowId);
  }

  private handleScheduleChange(
    workflowId: WorkflowId,
    schedule: string | null,
    workflowName: string,
    catchUp?: ScheduleCatchUp,
  ): void {
    const effective = this.resolveSchedule(workflowName, schedule);
    if (catchUp) this.builtInCatchUp.set(workflowId, catchUp);
    else this.builtInCatchUp.delete(workflowId);
    if (effective) {
      const previous = this.cronExpressions.get(workflowId);
      this.scheduler.register(workflowId, effective);
      this.workflowNames.set(workflowId, workflowName);
      this.cronExpressions.set(workflowId, effective);
      // time spent unscheduled, or on another expression, was never missed
      if (this.started && previous !== effective) {
        this.trackStateWrite(
          this.writeScheduleState(
            workflowId,
            workflowName,
            new Date(this.now()),
          ),
        );
      }
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
      this.cronExpressions.delete(workflowId);
      const name = this.workflowNames.get(workflowId) ?? workflowName;
      this.workflowNames.delete(workflowId);
      this.lastQueueDelayMs.delete(name);
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
            "Trigger override for workflow {name} sets no schedule and the workflow has none — override is a no-op",
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

      this.handleScheduleChange(
        workflow.id,
        null,
        workflow.name,
        workflow.catchUp,
      );
    }
  }

  async updateTriggerOverrides(
    newOverrides: ReadonlyMap<string, TriggerOverride>,
  ): Promise<number> {
    const oldOverrides = this.triggerOverrides;
    this.triggerOverrides = newOverrides;
    let changed = 0;

    for (const [workflowName] of oldOverrides) {
      if (newOverrides.has(workflowName)) continue;

      const workflowId = this.findWorkflowIdByName(workflowName);
      if (workflowId) {
        const workflow = await this.deps.workflowRepo.findByName(workflowName);
        this.handleScheduleChange(
          workflowId,
          workflow?.schedule ?? null,
          workflowName,
          workflow?.catchUp,
        );
        changed++;
      }
    }

    for (const [workflowName, newOverride] of newOverrides) {
      const oldOverride = oldOverrides.get(workflowName);

      if (
        oldOverride?.schedule === newOverride.schedule &&
        JSON.stringify(oldOverride?.inputs) ===
          JSON.stringify(newOverride.inputs) &&
        JSON.stringify(oldOverride?.catchUp) ===
          JSON.stringify(newOverride.catchUp)
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
          workflow?.catchUp,
        );
        changed++;
      } else if (newOverride.schedule) {
        const workflow = await this.deps.workflowRepo.findByName(workflowName);
        if (workflow) {
          this.handleScheduleChange(
            workflow.id,
            null,
            workflow.name,
            workflow.catchUp,
          );
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

  /**
   * the catch-up pass reads each schedule's state itself, so a promoted
   * instance whose cache went stale reports what the leader wrote
   */
  async catchUpMissedFires(): Promise<void> {
    if (!this.deps.scheduleState || this.draining || this.stopped) return;
    const now = new Date(this.now());
    for (const entry of this.scheduler.listSchedules()) {
      // the expression as registered: croner reports a nickname expanded
      const expression = this.cronExpressions.get(entry.workflowId) ??
        entry.cronExpression;
      try {
        await this.catchUpSchedule(entry.workflowId, expression, now);
      } catch (error) {
        logger.warn(
          "Cannot check workflow {name} for missed scheduled fires: {error}",
          {
            name: this.workflowNames.get(entry.workflowId) ?? entry.workflowId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    this.catchUpPassed = true;
    this.firstOwnFire.clear();
  }

  private async catchUpSchedule(
    workflowId: WorkflowId,
    cronExpression: string,
    now: Date,
  ): Promise<void> {
    const workflowName = this.workflowNames.get(workflowId) ?? workflowId;
    if (this.firstOwnFire.has(workflowId)) {
      await this.recordGapBeforeOwnFire(
        workflowId,
        workflowName,
        cronExpression,
        now,
      );
      return;
    }

    const stored = await this.deps.scheduleState!.get(workflowId);
    // with nothing seen before, or measured on another expression, no slot of
    // this one can be called missed
    if (!stored || stored.cronExpression !== cronExpression) {
      await this.writeScheduleState(workflowId, workflowName, now);
      return;
    }
    this.cacheState(stored);

    const catchUp = this.resolveCatchUp(workflowId, workflowName);
    let missed = evaluateMissedFires(
      cronExpression,
      new Date(stored.lastEvaluatedFireTime),
      now,
      catchUp,
    );
    if (missed.missedCount === 0) return;
    const recorded = await this.latestScheduledSlot(workflowId);
    // a run that recorded its slot settles it even if the watermark write
    // failed; a slot after now was never fired, so it settles nothing
    if (
      recorded &&
      recorded.getTime() > Date.parse(stored.lastEvaluatedFireTime) &&
      recorded.getTime() <= now.getTime()
    ) {
      missed = evaluateMissedFires(cronExpression, recorded, now, catchUp);
    }
    if (!missed.catchUpFireTime) {
      await this.recordMissed(
        workflowId,
        workflowName,
        missed,
        now,
        catchUp?.policy === "latest" ? catchUp : undefined,
      );
      return;
    }

    // a tick that began during the awaits above owns the latest slot now
    if (this.firstOwnFire.has(workflowId)) {
      await this.recordGapBeforeOwnFire(
        workflowId,
        workflowName,
        cronExpression,
        now,
      );
      return;
    }
    const outcome = await this.trackedFire(
      workflowId,
      missed.catchUpFireTime,
      missedFireOf(missed, now),
    );
    // claimed elsewhere, the claimer records it; dropped, the next boot does
    if (outcome === "claimed_elsewhere" || outcome === "dropped") return;
    const caughtUp = outcome === "queued";
    this.emitMissed(workflowId, workflowName, missed, caughtUp);
    this.logMissed(workflowName, missed, caughtUp);
  }

  /**
   * a slot already fired here, so only the gap before it was missed and nothing
   * is caught up; while that fire has not settled, nothing is recorded
   */
  private async recordGapBeforeOwnFire(
    workflowId: WorkflowId,
    workflowName: string,
    cronExpression: string,
    now: Date,
  ): Promise<void> {
    const own = this.firstOwnFire.get(workflowId)!;
    if (!own.prior || own.prior.cronExpression !== cronExpression) return;
    const missed = evaluateMissedFires(
      cronExpression,
      new Date(own.prior.lastEvaluatedFireTime),
      new Date(Math.min(own.slot.getTime() - 1, now.getTime())),
    );
    await this.recordMissed(workflowId, workflowName, missed, now);
  }

  private async recordMissed(
    workflowId: WorkflowId,
    workflowName: string,
    missed: MissedFires,
    now: Date,
    tooLateFor?: ScheduleCatchUp,
  ): Promise<void> {
    if (!missed.latestMissed) return;
    // an instance not allowed to write reports nothing; peers that may all write
    // (no v3 leadership) can each report the same miss
    const wrote = await this.writeScheduleState(
      workflowId,
      workflowName,
      missed.latestMissed,
      {
        lastMissed: missedFireOf(missed, now),
      },
    );
    if (!wrote) return;
    this.emitMissed(workflowId, workflowName, missed, false);
    this.logMissed(workflowName, missed, false, tooLateFor);
  }

  private logMissed(
    workflowName: string,
    missed: MissedFires,
    caughtUp: boolean,
    tooLateFor?: ScheduleCatchUp,
  ): void {
    const values = {
      name: workflowName,
      count: missed.saturated ? `${missed.missedCount}+` : missed.missedCount,
      fireTime: missed.latestMissed!.toISOString(),
      maxDelay: tooLateFor?.maxDelay,
    };
    if (caughtUp) {
      logger.warn(
        "Workflow {name} missed {count} scheduled fire(s) while serve was down; catching up the one at {fireTime}",
        values,
      );
    } else if (tooLateFor?.maxDelay !== undefined) {
      logger.warn(
        "Workflow {name} missed {count} scheduled fire(s) while serve was down, the latest at {fireTime}; not caught up, it is older than the catch-up maxDelay {maxDelay}",
        values,
      );
    } else {
      logger.warn(
        "Workflow {name} missed {count} scheduled fire(s) while serve was down, the latest at {fireTime}",
        values,
      );
    }
  }

  /** never rejects: without run history, the watermark alone decides */
  private async latestScheduledSlot(
    workflowId: WorkflowId,
  ): Promise<Date | null> {
    const lookup = this.deps.latestScheduledSlot;
    if (!lookup) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        lookup(workflowId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`timed out after ${RUN_HISTORY_TIMEOUT_MS}ms`),
              ),
            RUN_HISTORY_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      logger.warn(
        "Cannot read the scheduled runs of workflow {name}: {error}",
        {
          name: this.workflowNames.get(workflowId) ?? workflowId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private cacheState(state: ScheduleState): void {
    const id = state.workflowId as WorkflowId;
    const cached = this.scheduleStates.get(id);
    if (
      !cached ||
      Date.parse(state.lastEvaluatedFireTime) >=
        Date.parse(cached.lastEvaluatedFireTime)
    ) {
      this.scheduleStates.set(id, state);
    }
  }

  private emitMissed(
    workflowId: WorkflowId,
    workflowName: string,
    missed: MissedFires,
    caughtUp: boolean,
  ): void {
    this.emit({
      kind: "schedule_missed",
      workflowId,
      workflowName,
      fireTime: missed.latestMissed!.toISOString(),
      oldestFireTime: missed.oldestMissed!.toISOString(),
      missedCount: missed.missedCount,
      saturated: missed.saturated,
      caughtUp,
    });
  }

  /**
   * a catch-up fire carries the missed fire the startup pass found, which its
   * settled state records in place of a paused or overlap miss
   */
  private async handleFire(
    workflowId: WorkflowId,
    fireTime: Date,
    catchUpOf?: MissedFire,
  ): Promise<FireOutcome> {
    const workflowName = this.workflowNames.get(workflowId) ?? workflowId;
    const catchUp = catchUpOf !== undefined;
    // registered before any await, so a catch-up pass running alongside sees it
    const own = !catchUp && !this.catchUpPassed &&
        !this.firstOwnFire.has(workflowId)
      ? { prior: undefined, slot: fireTime }
      : undefined;
    if (own) this.firstOwnFire.set(workflowId, own);
    const lostFire = (reason: MissedFireReason): MissedFire =>
      catchUpOf ?? {
        fireTime: fireTime.toISOString(),
        count: 1,
        reason,
        caughtUp: false,
        detectedAt: new Date(this.now()).toISOString(),
      };

    if (this.deps.schedulePauses) {
      const pause = await this.pauseInForce(workflowId, workflowName, fireTime);
      if (pause) {
        this.emitPausedSkip(workflowId, workflowName, pause, {
          fireTime: fireTime.toISOString(),
        });
        await this.writeScheduleState(workflowId, workflowName, fireTime, {
          lastMissed: lostFire("paused"),
          ownFire: true,
        });
        return "paused";
      }
    }

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
      await this.writeScheduleState(workflowId, workflowName, fireTime, {
        lastMissed: lostFire("overlap"),
        ownFire: true,
      });
      return "overlap";
    }

    // A draining service starts no new runs; checked again after the dedup
    // await, which can span the start of a drain.
    if (this.draining) return "dropped";

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
          if (own && this.firstOwnFire.get(workflowId) === own) {
            this.firstOwnFire.delete(workflowId);
          }
          return "claimed_elsewhere";
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
    // Settled before the drain check below: a slot recorded for replay must
    // never also be found missed on the next boot, or it would run twice.
    await this.writeScheduleState(workflowId, workflowName, fireTime, {
      lastMissed: catchUpOf ? { ...catchUpOf, caughtUp: true } : undefined,
      ownFire: true,
    });
    if (this.draining) {
      // This instance may have claimed the fire slot, so peers skip it.
      // Record the fire for the next boot to replay instead of dropping it
      // cluster-wide.
      await this.recordForReplay(workflowName);
      return "dropped";
    }

    this.emit({
      kind: "schedule_fired",
      workflowId,
      workflowName,
      fireTime: fireTime.toISOString(),
      ...(catchUp ? { catchUp: true } : {}),
    });
    logger.info(
      catchUp
        ? "Firing catch-up run for workflow {name}"
        : "Firing scheduled run for workflow {name}",
      { name: workflowName },
    );

    // Queue the run. Up to maxConcurrentRuns entries run at once (default
    // 1, one at a time as before); a workflow never overlaps itself. Two
    // workflows that touch the same model still exclude each other through
    // the per-model lock.
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
      enqueuedAt: this.now(),
      replayed: false,
      ...(catchUp ? { catchUp: true } : {}),
    });
    this.processQueue();
    return "queued";
  }

  /** a drain waits for tracked fires, which may be recording a claimed slot */
  private trackedFire(
    workflowId: WorkflowId,
    fireTime: Date,
    catchUpOf?: MissedFire,
  ): Promise<FireOutcome> {
    const fire = this.handleFire(workflowId, fireTime, catchUpOf);
    const settled: Promise<void> = fire.then(() => {}, () => {}).finally(() =>
      this.inFlightFires.delete(settled)
    );
    this.inFlightFires.add(settled);
    return fire;
  }

  private async loadScheduleStates(): Promise<void> {
    if (!this.deps.scheduleState) return;
    try {
      for (const state of await this.deps.scheduleState.list()) {
        this.cacheState(state);
      }
    } catch (error) {
      logger.warn("Cannot read schedule states: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * never rejects: a store that fails or hangs past its deadline must not drop
   * or delay a fire, so the failure is logged and the fire goes ahead. The
   * stored record is re-read so a stale cache never moves the watermark back
   */
  private async writeScheduleState(
    workflowId: WorkflowId,
    workflowName: string,
    fireTime: Date,
    options: { lastMissed?: MissedFire; ownFire?: boolean } = {},
  ): Promise<boolean> {
    const repo = this.deps.scheduleState;
    if (!repo) return false;
    let stored: ScheduleState | null | undefined;
    // a draining fire must reach replay within the settle budget, so it skips
    // the re-read; otherwise an unread record is never overwritten from the
    // cache, which could move a peer's later watermark back
    let readError: unknown;
    if (!this.draining) {
      try {
        stored = await repo.get(workflowId);
        if (stored) this.cacheState(stored);
      } catch (error) {
        readError = error;
      }
    }
    const next = advanceScheduleState(
      this.scheduleStates.get(workflowId) ?? null,
      workflowId,
      workflowName,
      fireTime,
      options.lastMissed,
      this.cronExpressions.get(workflowId),
    );
    let wrote: boolean | "failed";
    try {
      if (readError !== undefined) throw readError;
      wrote = await repo.save(next);
    } catch (error) {
      wrote = "failed";
      logger.warn(
        "Cannot record the schedule state of workflow {name}: {error}",
        {
          name: workflowName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    const own = options.ownFire ? this.firstOwnFire.get(workflowId) : undefined;
    if (own && own.slot.getTime() === fireTime.getTime()) {
      // a non-writer settled nothing; a failed write still fired the slot
      if (wrote === false) this.firstOwnFire.delete(workflowId);
      else own.prior = stored;
    }
    if (wrote === false) return false;
    if (wrote === true) this.scheduleStates.set(workflowId, next);
    return wrote === true;
  }

  private trackStateWrite(write: Promise<unknown>): void {
    const tracked: Promise<void> = write.then(() => {}).finally(() =>
      this.stateWrites.delete(tracked)
    );
    this.stateWrites.add(tracked);
  }

  /**
   * The pause in force for a workflow at `at`, or null. When the pause store
   * cannot be read, the pause last read for the workflow decides; with none
   * read yet the fire proceeds, since failing closed would stop every
   * schedule during a datastore outage.
   */
  private async pauseInForce(
    workflowId: WorkflowId,
    workflowName: string,
    at: Date,
  ): Promise<SchedulePause | null> {
    const repo = this.deps.schedulePauses;
    if (!repo) return null;
    let pause: SchedulePause | null;
    try {
      pause = await repo.get(workflowId);
      this.lastPauseRead.set(workflowId, pause);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      if (this.lastPauseRead.has(workflowId)) {
        pause = this.lastPauseRead.get(workflowId) ?? null;
        logger.warn(
          "Cannot read the schedule pause of workflow {name}; using the state last read ({state}): {error}",
          { name: workflowName, state: pause ? "paused" : "not paused", error },
        );
      } else {
        logger.warn(
          "Cannot read the schedule pause of workflow {name} and none was read before; firing as not paused: {error}",
          { name: workflowName, error },
        );
        return null;
      }
    }
    return pause && isSchedulePauseActiveAt(pause, at) ? pause : null;
  }

  private emitPausedSkip(
    workflowId: WorkflowId,
    workflowName: string,
    pause: SchedulePause,
    when: { fireTime?: string; replayed?: true },
  ): void {
    this.emit({
      kind: "schedule_skipped",
      workflowId,
      workflowName,
      reason: pause.reason === undefined
        ? "paused"
        : `paused (${pause.reason})`,
      paused: {
        reason: pause.reason,
        pausedBy: pause.pausedBy,
        until: pause.until,
      },
      ...when,
    });
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

  /**
   * while fewer than maxConcurrentRuns are in flight, starts the first queued
   * entry whose workflow is not already in flight; with one slot entries start
   * in queue order
   */
  private processQueue(): void {
    while (this.inFlight.size < this.maxConcurrentRuns) {
      const index = this.runQueue.findIndex((entry) =>
        !this.identityOf(entry).some((key) => this.claimed.has(key))
      );
      if (index === -1) return;
      const [entry] = this.runQueue.splice(index, 1);
      const identity = this.identityOf(entry);
      for (const key of identity) this.claimed.add(key);
      const settled: Promise<void> = this.runEntry(entry).finally(() => {
        for (const key of identity) this.claimed.delete(key);
        this.inFlight.delete(settled);
        try {
          this.processQueue();
        } catch (error) {
          logger.error("Scheduled run queue stalled: {error}", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      this.inFlight.add(settled);
    }
  }

  /**
   * The keys a queue entry's workflow is known by. A fired entry carries the
   * workflow's id, a replayed one its name; both resolve to the same set so
   * the two never overlap.
   */
  private identityOf(entry: QueuedRun): string[] {
    const keys = new Set<string>([entry.workflowId, entry.workflowName]);
    const name = this.workflowNames.get(entry.workflowId);
    if (name) keys.add(name);
    const id = this.findWorkflowIdByName(entry.workflowName);
    if (id) keys.add(id);
    return [...keys];
  }

  /** Never rejects: a failure is logged and the queue keeps going. */
  private async runEntry(entry: QueuedRun): Promise<void> {
    try {
      const { pendingRunId, enqueuePromise } = entry;
      if (enqueuePromise) await enqueuePromise;
      // A drain that began while this entry was dequeued leaves it pending
      // for the next boot to replay rather than starting it now.
      if (this.draining) return;
      if (pendingRunId && this.deps.pendingRunHook) {
        await this.deps.pendingRunHook.delete(pendingRunId);
      }
      // A queued fire may predate a pause made while it waited, in this
      // process or before a restart. Its pending entry is consumed either way.
      if (this.deps.schedulePauses) {
        const workflowId = this.findWorkflowIdByName(entry.workflowName) ??
          entry.workflowId;
        const pause = await this.pauseInForce(
          workflowId,
          entry.workflowName,
          new Date(this.now()),
        );
        if (pause) {
          this.emitPausedSkip(workflowId, entry.workflowName, pause, {
            fireTime: entry.fireTime?.toISOString(),
            replayed: entry.replayed ? true : undefined,
          });
          return;
        }
      }
      // each entry starts outside any vault scope: the run enters its own
      // principal's scope, and the queue's inherited context never carries
      // another entry's
      await withoutVaultAccess(() => this.executeWorkflow(entry));
    } catch (error) {
      logger.error(
        "Scheduled run for workflow {name} did not start: {error}",
        {
          name: entry.workflowName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async executeWorkflow(entry: QueuedRun): Promise<void> {
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
      const principal = this.deps.initiatedBy ?? "the scheduler";
      logger.warn(
        "Scheduled run refused for workflow {name} as {principal}: {reason}. Check with: swamp access check --subject {principal} --action run --on workflow:{name}",
        {
          name: workflowName,
          principal,
          reason: authorization.reason ?? "denied",
        },
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

      await withRootSpan(
        "swamp.scheduled.fire",
        { "workflow.id": String(workflowId), "workflow.name": workflowName },
        async (_span) => {
          await this.deps.executeWorkflow(
            {
              workflowIdOrName: authorization.workflowIdOrName,
              inputs: override?.inputs,
              initiatedBy: this.deps.initiatedBy,
              ...(fireTime
                ? {
                  runtimeTags: {
                    [SCHEDULED_FOR_TAG]: fireTime,
                    ...(entry.catchUp ? { [CATCH_UP_TAG]: "true" } : {}),
                  },
                }
                : {}),
            },
            controller.signal,
            (event) => {
              // A nested workflow's started event carries the child's run
              // id; this schedule's run is the one without a parent.
              if (event.kind === "started" && event.parentRunId === undefined) {
                runId = event.runId;
                const queueDelayMs = Math.max(
                  0,
                  this.now() -
                    (entry.fireTime?.getTime() ?? entry.enqueuedAt),
                );
                // Keyed by the resolved name, which queueStatus looks up,
                // even when a replayed entry carries the workflow's id.
                this.lastQueueDelayMs.set(
                  this.workflowNames.get(workflowId) ?? workflowName,
                  queueDelayMs,
                );
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
                  queueDelayMs,
                  ...(entry.catchUp ? { catchUp: true } : {}),
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
 * a deterministic key component shared across instances: second precision, ISO
 * UTC without milliseconds, colons replaced by hyphens for Windows filenames
 */
export function normalizeFireTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

function missedFireOf(missed: MissedFires, now: Date): MissedFire {
  return {
    fireTime: missed.latestMissed!.toISOString(),
    count: missed.missedCount,
    ...(missed.saturated ? { saturated: true } : {}),
    reason: "serve_down",
    caughtUp: false,
    detectedAt: now.toISOString(),
  };
}

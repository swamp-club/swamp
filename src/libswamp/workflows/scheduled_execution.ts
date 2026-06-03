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

export interface ScheduledExecutionDeps {
  workflowRepo: WorkflowRepository;
  repoDir: string;
  executeWorkflow: WorkflowExecutor;
}

export class ScheduledExecutionService {
  private readonly scheduler: WorkflowScheduler;
  private readonly watcher: WorkflowWatcher;
  private readonly running = new Map<WorkflowId, AbortController>();
  private readonly workflowNames = new Map<WorkflowId, string>();
  private readonly runQueue: Array<{
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
   * 2. Starts the filesystem watcher for live reload
   * 3. Starts the scheduler to fire cron jobs
   */
  async start(
    onEvent?: ScheduledExecutionEventHandler,
  ): Promise<void> {
    this.eventHandler = onEvent ?? null;

    // Scan existing workflows and register schedules
    await this.watcher.scanExisting();

    // Start the scheduler — cron jobs begin firing
    this.scheduler.start((workflowId) => this.handleFire(workflowId));

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
    for (const [workflowId, controller] of this.running) {
      logger.info(
        "Aborting in-flight scheduled run for workflow {workflowId}",
        { workflowId },
      );
      controller.abort();
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

  private handleScheduleChange(
    workflowId: WorkflowId,
    schedule: string | null,
    workflowName: string,
  ): void {
    if (schedule) {
      this.scheduler.register(workflowId, schedule);
      this.workflowNames.set(workflowId, workflowName);
      this.emit({
        kind: "schedule_registered",
        workflowId,
        workflowName,
        cronExpression: schedule,
      });
      logger.info(
        "Registered schedule for workflow {name}: {schedule}",
        { name: workflowName, schedule },
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

  private handleFire(workflowId: WorkflowId): void {
    const workflowName = this.workflowNames.get(workflowId) ?? workflowId;

    // Overlap prevention — skip if this specific workflow is already running
    if (this.running.has(workflowId)) {
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
    this.runQueue.push({ workflowId, workflowName });
    if (!this.processing) {
      this.processingPromise = this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.runQueue.length > 0) {
        const { workflowId, workflowName } = this.runQueue.shift()!;
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
    this.running.set(workflowId, controller);

    try {
      let runId = "";

      await this.deps.executeWorkflow(
        { workflowIdOrName: workflowName },
        controller.signal,
        (event) => {
          if (event.kind === "started") {
            runId = event.runId;
          }
        },
      );

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
    }
  }

  private emit(event: ScheduledExecutionEvent): void {
    this.eventHandler?.(event);
  }
}

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
 * every trigger source stops taking new work and drains in-flight runs
 * alongside the active-run registry against one deadline; only then is what is
 * left aborted
 */

import type { ActiveRun } from "./active_run_registry.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "shutdown"]);

/** a webhook or cron run a trigger source aborted when it stopped */

/** the reason every shutdown abort carries, which a user cancel never does */
export const SHUTDOWN_ABORT_MESSAGE = "server shutdown";

export interface StoppedTriggerRun {
  readonly runId: string;
  readonly workflowId?: string;
  readonly workflowName: string;
  readonly startedAt: Date;
}

export interface DrainableTriggerSource {
  drain(timeoutMs: number): Promise<void>;
  /** the runs it aborted, leaving out any already cancelled on purpose */
  stop(): Promise<readonly StoppedTriggerRun[]>;
}

export type ShutdownAbortedRun =
  & Pick<ActiveRun, "runId" | "kind" | "resourceName" | "startedAt">
  & Partial<Pick<ActiveRun, "resourceId">>;

export interface DrainableRunRegistry {
  readonly size: number;
  beginDraining(): void;
  drainAll(timeoutMs: number): Promise<void>;
  list(): ReadonlyArray<ActiveRun>;
}

/**
 * How long serve's shutdown gives the runs it aborted to settle before it
 * marks them interrupted. A cancelled run waits at most
 * `STEP_STOP_GRACE_MS` for its model methods to stop, which stays under this.
 */
export const SHUTDOWN_ABORT_GRACE_MS = 5_000;

export interface ShutdownDrainDeps {
  readonly webhookService: DrainableTriggerSource | null;
  readonly scheduledExecution: DrainableTriggerSource | null;
  readonly activeRunRegistry: DrainableRunRegistry | null;
  readonly drainTimeoutMs: number;
  readonly abortGraceMs: number;
  readonly onAborting?: (undrained: number) => void;
}

export async function runShutdownDrain(
  deps: ShutdownDrainDeps,
): Promise<ReadonlyArray<ShutdownAbortedRun>> {
  const { webhookService, scheduledExecution, activeRunRegistry } = deps;
  // First, whatever the drain does next: a run registered from here on
  // (a chained auto-resume, say) would never be drained or aborted.
  activeRunRegistry?.beginDraining();

  const drains: Array<{ name: string; promise: Promise<void> }> = [];
  if (webhookService) {
    drains.push({
      name: "webhooks",
      promise: webhookService.drain(deps.drainTimeoutMs),
    });
  }
  if (scheduledExecution) {
    drains.push({
      name: "schedules",
      promise: scheduledExecution.drain(deps.drainTimeoutMs),
    });
  }
  // drainAll treats 0 as "wait forever", so a zero drain skips it.
  if (activeRunRegistry && deps.drainTimeoutMs > 0) {
    const activeCount = activeRunRegistry.size;
    if (activeCount > 0) {
      logger.info`Draining ${activeCount} active run(s)...`;
      drains.push({
        name: "active runs",
        promise: activeRunRegistry.drainAll(deps.drainTimeoutMs),
      });
    }
  }

  // allSettled: a rejected drain must not skip the abort below, nor the
  // interrupt marking and teardown the caller runs afterwards.
  const results = await Promise.allSettled(drains.map((d) => d.promise));
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      logger.warn("Draining {source} failed: {error}", {
        source: drains[i].name,
        error: result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      });
    }
  });

  const stopped = [
    ...await stopSource("webhooks", webhookService),
    ...await stopSource("schedules", scheduledExecution),
  ];

  const remaining = activeRunRegistry?.list() ?? [];
  if (remaining.length > 0) {
    deps.onAborting?.(remaining.length);
    logger.info`Aborting ${remaining.length} undrained run(s)...`;
    for (const run of remaining) {
      run.controller.abort(new Error(SHUTDOWN_ABORT_MESSAGE));
    }
    await activeRunRegistry!.drainAll(deps.abortGraceMs);
  }
  return [
    ...remaining,
    ...stopped.map((run): ShutdownAbortedRun => ({
      runId: run.runId,
      kind: "workflow-run",
      resourceName: run.workflowName,
      ...(run.workflowId !== undefined ? { resourceId: run.workflowId } : {}),
      startedAt: run.startedAt,
    })),
  ];
}

async function stopSource(
  name: string,
  source: DrainableTriggerSource | null,
): Promise<readonly StoppedTriggerRun[]> {
  if (!source) return [];
  try {
    return await source.stop();
  } catch (error) {
    logger.warn("Stopping {source} failed: {error}", {
      source: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

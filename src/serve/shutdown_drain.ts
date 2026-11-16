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
import {
  isInterruption,
  RunInterruption,
  stopGraceFor,
} from "../domain/workflows/run_interruption.ts";
import {
  cancelCause,
  CLEANUP_GRACE_TIMEOUT_MS,
} from "../domain/models/cancel_cause.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "shutdown"]);

/** the reason every shutdown abort carries, which a user cancel never does */
export const SHUTDOWN_ABORT_MESSAGE = "server shutdown";

/** a webhook or cron run a trigger source aborted when it stopped */
export interface StoppedTriggerRun {
  readonly runId: string;
  readonly workflowId?: string;
  readonly workflowName: string;
  readonly startedAt: Date;
  /** set when a user cancelled it first: shutdown settles it, never interrupts it */
  readonly cancelledBeforeShutdown?: CancelledBeforeShutdown;
}

/** a run a user cancelled before shutdown, still running its cleanup when the wait ended */
export interface CancelledBeforeShutdown {
  readonly reason?: string;
}

export interface DrainableTriggerSource {
  drain(timeoutMs: number): Promise<void>;
  /**
   * the runs it aborted, and the cancelled ones still running; waits at most
   * stopGraceFor's bound when abortGraceMs is given
   */
  stop(
    abortGraceMs?: number,
    cleanupGraceMs?: number,
  ): Promise<readonly StoppedTriggerRun[]>;
  /** a run stop() aborted is still going, so it may still be writing */
  hasUnsettledRuns(): boolean;
}

export type ShutdownAbortedRun =
  & Pick<ActiveRun, "runId" | "kind" | "resourceName" | "startedAt">
  & Partial<Pick<ActiveRun, "resourceId">>
  & { readonly cancelledBeforeShutdown?: CancelledBeforeShutdown };

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

/**
 * the extra wait a cancelled run's cleanup gets, from what is left of the
 * shutdown deadline once the drain ends, less what the stages after the drain
 * need, so the wait never carries shutdown past its deadline
 */
export function cleanupGraceWithin(leftMs: number, reservedMs: number): number {
  return Math.max(0, Math.min(CLEANUP_GRACE_TIMEOUT_MS, leftMs - reservedMs));
}

export interface ShutdownDrainDeps {
  readonly webhookService: DrainableTriggerSource | null;
  readonly scheduledExecution: DrainableTriggerSource | null;
  readonly activeRunRegistry: DrainableRunRegistry | null;
  readonly drainTimeoutMs: number;
  readonly abortGraceMs: number;
  /**
   * read once the drain ends: how long a cancelled run's cleanup may extend
   * the wait; the engine's cleanup grace when unset
   */
  readonly cleanupGraceMs?: () => number;
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

  // every source is aborted at once, so all share the one abort grace
  const registered = activeRunRegistry?.list() ?? [];
  // a run a user cancelled first stays cancelled and its cleanup is waited for,
  // as the trigger sources' stop does
  const cleanupGraceMs = deps.cleanupGraceMs?.();
  const registryWait = stopGraceFor(
    registered,
    deps.abortGraceMs,
    cleanupGraceMs,
  );
  const remaining = registered.filter((run) => !run.controller.signal.aborted);
  if (remaining.length > 0) {
    deps.onAborting?.(remaining.length);
    logger.info`Aborting ${remaining.length} undrained run(s)...`;
    for (const run of remaining) {
      run.controller.abort(new RunInterruption("server_shutdown"));
    }
  }
  const [webhookRuns, scheduledRuns] = await Promise.all([
    stopSource("webhooks", webhookService, deps.abortGraceMs, cleanupGraceMs),
    stopSource(
      "schedules",
      scheduledExecution,
      deps.abortGraceMs,
      cleanupGraceMs,
    ),
    registered.length > 0
      ? activeRunRegistry!.drainAll(registryWait)
      : Promise.resolve(),
  ]);
  const stopped = [...webhookRuns, ...scheduledRuns];
  const stillRegistered = new Set(
    (activeRunRegistry?.list() ?? []).map((run) => run.runId),
  );
  const cancelledLeft = registered.filter((run) =>
    run.controller.signal.aborted && !isInterruption(run.controller.signal) &&
    stillRegistered.has(run.runId)
  );
  return [
    ...remaining,
    ...cancelledLeft.map((run): ShutdownAbortedRun => ({
      runId: run.runId,
      kind: run.kind,
      resourceName: run.resourceName,
      ...(run.resourceId !== undefined ? { resourceId: run.resourceId } : {}),
      startedAt: run.startedAt,
      cancelledBeforeShutdown: { reason: cancelCause(run.controller.signal) },
    })),
    ...stopped.map((run): ShutdownAbortedRun => ({
      runId: run.runId,
      kind: "workflow-run",
      resourceName: run.workflowName,
      ...(run.workflowId !== undefined ? { resourceId: run.workflowId } : {}),
      startedAt: run.startedAt,
      ...(run.cancelledBeforeShutdown
        ? { cancelledBeforeShutdown: run.cancelledBeforeShutdown }
        : {}),
    })),
  ];
}

async function stopSource(
  name: string,
  source: DrainableTriggerSource | null,
  abortGraceMs: number,
  cleanupGraceMs: number | undefined,
): Promise<readonly StoppedTriggerRun[]> {
  if (!source) return [];
  try {
    return await source.stop(abortGraceMs, cleanupGraceMs);
  } catch (error) {
    logger.warn("Stopping {source} failed: {error}", {
      source: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

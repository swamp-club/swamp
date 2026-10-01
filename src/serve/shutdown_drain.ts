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
 * The drain-then-abort stage of `swamp serve` shutdown (swamp-club#2484).
 *
 * Webhook and cron runs used to be aborted before the active-run drain even
 * started. Every trigger source now stops taking new work and drains its
 * in-flight run alongside the active-run registry, all against one deadline;
 * only then is whatever is left aborted.
 */

import type { ActiveRun } from "./active_run_registry.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "shutdown"]);

/** A trigger source (webhooks, cron) that can drain and then abort its runs. */
export interface DrainableTriggerSource {
  drain(timeoutMs: number): Promise<void>;
  stop(): Promise<void>;
}

/** The slice of `ActiveRunRegistry` the shutdown drain uses. */
export interface DrainableRunRegistry {
  readonly size: number;
  /** Refuses every later registration. */
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
  /** Shared drain deadline; 0 aborts in-flight runs without waiting. */
  readonly drainTimeoutMs: number;
  /** How long aborted registry runs get to settle. */
  readonly abortGraceMs: number;
  /** Called before undrained registry runs are aborted. */
  readonly onAborting?: (undrained: number) => void;
}

/**
 * Drains every trigger source and the active-run registry concurrently, then
 * aborts what did not finish. Returns the registry runs it aborted so the
 * caller can mark their workflow runs interrupted.
 */
export async function runShutdownDrain(
  deps: ShutdownDrainDeps,
): Promise<ReadonlyArray<ActiveRun>> {
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

  await stopSource("webhooks", webhookService);
  await stopSource("schedules", scheduledExecution);

  const remaining = activeRunRegistry?.list() ?? [];
  if (remaining.length > 0) {
    deps.onAborting?.(remaining.length);
    logger.info`Aborting ${remaining.length} undrained run(s)...`;
    for (const run of remaining) {
      run.controller.abort(new Error("server shutdown"));
    }
    await activeRunRegistry!.drainAll(deps.abortGraceMs);
  }
  return remaining;
}

async function stopSource(
  name: string,
  source: DrainableTriggerSource | null,
): Promise<void> {
  if (!source) return;
  try {
    await source.stop();
  } catch (error) {
    logger.warn("Stopping {source} failed: {error}", {
      source: name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

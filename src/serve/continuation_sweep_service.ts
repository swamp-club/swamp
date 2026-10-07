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
 * The continuation sweep (swamp-club#3108): finds the suspended runs that
 * need no further decision and continues them.
 *
 * The instance that accepts a run's last signal tries to continue it at
 * once, but that launch can be lost: the registry is full, the server is
 * shutting down or crashes, or the signal was delivered by the local
 * command. The sweep is the path that always comes back. It runs once at
 * boot and then on an interval, and each pass offers every suspended run
 * this instance has a record of to {@link continueSettledRun}, which decides
 * and launches through the run's continuation claim.
 */

import { runDetached } from "../infrastructure/tracing/mod.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { ConnectionContext } from "./handlers/shared.ts";
import { continueSettledRun } from "./resume_launcher.ts";

const logger = getSwampLogger(["serve", "continuation-sweep"]);

export const DEFAULT_CONTINUATION_SWEEP_INTERVAL_MS = 30_000;

/** What one pass did. */
export interface ContinuationSweepResult {
  /** Suspended runs looked at. */
  readonly examined: number;
  /** Resumes launched. */
  readonly launched: number;
}

/**
 * One pass over the suspended runs this instance has a record of. A run
 * that cannot be read, or whose continuation fails, is logged and passed
 * over, so one damaged run never stops the pass.
 *
 * `takeover` lets the pass replace the claim of a holder known to be dead.
 * It is right only while this instance's run records are current: always on
 * a filesystem datastore, and on a synced one only straight after the boot
 * hydration.
 */
export async function sweepContinuations(
  ctx: ConnectionContext,
  options: { takeover: boolean; isStopping?: () => boolean },
): Promise<ContinuationSweepResult> {
  let examined = 0;
  let launched = 0;
  const runRepo = ctx.repoContext.workflowRunRepo;
  for (const workflow of await ctx.repoContext.workflowRepo.findAll()) {
    if (options.isStopping?.()) break;
    let suspended;
    try {
      suspended = await runRepo.findSummariesByStatus(workflow.id, "suspended");
    } catch (error) {
      logger.warn(
        "Could not list the suspended runs of workflow {workflow}: {error}",
        {
          workflow: workflow.name,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      continue;
    }
    for (const summary of suspended) {
      if (options.isStopping?.()) break;
      examined++;
      try {
        const started = await continueSettledRun(
          ctx,
          { workflowId: workflow.id, runId: summary.id },
          { kind: "sweep", principalId: null, takeover: options.takeover },
        );
        if (started) launched++;
      } catch (error) {
        logger.warn(
          "Could not continue run {runId}: {error}",
          {
            runId: summary.id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }
  return { examined, launched };
}

export interface ContinuationSweepDeps {
  readonly intervalMs: number;
  /** One pass; `boot` is true for the first pass after the server started. */
  sweep(
    pass: { boot: boolean; isStopping: () => boolean },
  ): Promise<ContinuationSweepResult>;
}

/** Whether serve starts the sweep, and why not when it does not. */
export type ContinuationSweepStart =
  | "start"
  /** The interval is 0. */
  | "disabled"
  /**
   * A synced datastore with no continuation claims every instance reads: no
   * shared control-plane store, or one that cannot create a record
   * atomically. The claim is all that keeps two instances there from
   * resuming one run from their own copies of it.
   */
  | "no_shared_claims"
  /** The boot hydration did not complete, so the run records may be old. */
  | "records_not_current";

export function decideContinuationSweepStart(options: {
  intervalMs: number;
  syncedDatastore: boolean;
  sharedClaims: boolean;
  runRecordsCurrentAtBoot: boolean;
}): ContinuationSweepStart {
  if (options.intervalMs === 0) return "disabled";
  if (options.syncedDatastore && !options.sharedClaims) {
    return "no_shared_claims";
  }
  if (!options.runRecordsCurrentAtBoot) return "records_not_current";
  return "start";
}

/** Runs the continuation sweep at boot and then on an interval. */
export class ContinuationSweepService {
  readonly #deps: ContinuationSweepDeps;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #disposed = false;
  #booted = false;

  constructor(deps: ContinuationSweepDeps) {
    this.#deps = deps;
  }

  /**
   * Starts the boot pass and schedules the rest after it. The pass is not
   * awaited: it reads every suspended run, and serve must not hold its
   * readiness on that. `dispose` and `runOnce` wait for it.
   */
  start(): void {
    if (this.#disposed) return;
    logger.info(
      "Starting continuation sweep (interval: {interval}s)",
      { interval: this.#deps.intervalMs / 1000 },
    );
    void this.#passThenSchedule();
  }

  /** Stops the schedule and waits for a pass in flight. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#running) await this.#running;
  }

  /** One pass now. A pass already in flight is awaited instead. */
  async runOnce(): Promise<void> {
    if (this.#running) return await this.#running;
    this.#running = this.#pass().finally(() => {
      this.#running = null;
    });
    await this.#running;
  }

  async #pass(): Promise<void> {
    const boot = !this.#booted;
    this.#booted = true;
    try {
      const result = await this.#deps.sweep({
        boot,
        isStopping: () => this.#disposed,
      });
      if (result.launched > 0) {
        logger.info(
          "Continuation sweep: continued {launched} of {examined} suspended run(s)",
          { launched: result.launched, examined: result.examined },
        );
      }
    } catch (error) {
      logger.error`Continuation sweep failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  /** One pass, then the next one's timer. Never rejects: a pass does not. */
  async #passThenSchedule(): Promise<void> {
    await this.runOnce();
    this.#scheduleNext();
  }

  #scheduleNext(): void {
    if (this.#disposed) return;
    this.#timer = runDetached(() =>
      setTimeout(() => {
        void this.#passThenSchedule();
      }, this.#deps.intervalMs)
    );
    Deno.unrefTimer(this.#timer);
  }
}

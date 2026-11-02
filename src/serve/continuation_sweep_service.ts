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
 * the last signal's launch can be lost (full registry, shutdown, crash); the
 * sweep always comes back, at boot and on an interval, and settles waits past
 * their deadline as timed out
 */

import { sweepPendingSignals } from "../domain/workflows/signal_wait_cleanup.ts";
import type { WorkflowId } from "../domain/workflows/workflow_id.ts";
import type { WorkflowRunSummary } from "../domain/workflows/workflow_run_summary.ts";
import { runDetached } from "../infrastructure/tracing/mod.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { ConnectionContext } from "./handlers/shared.ts";
import { continueSettledRun } from "./resume_launcher.ts";
import { STOPPED, stoppedBy, untilStopped } from "./until_stopped.ts";

const logger = getSwampLogger(["serve", "continuation-sweep"]);

export const DEFAULT_CONTINUATION_SWEEP_INTERVAL_MS = 30_000;

export interface ContinuationSweepResult {
  readonly examined: number;
  readonly launched: number;
}

/**
 * a run that cannot be read or continued is logged and passed over; takeover
 * replaces a dead holder's claim and is right only while this instance's run
 * records are current
 */
export async function sweepContinuations(
  ctx: ConnectionContext,
  options: {
    takeover: boolean;
    isStopping?: () => boolean;
    /**
     * aborts the listing of suspended runs: an index rebuild stops between
     * records and writes no index once no other reader needs it; the pass stops
     * waiting at once, even when queued behind another reader
     */
    signal?: AbortSignal;
    now?: () => number;
  },
): Promise<ContinuationSweepResult> {
  let examined = 0;
  let launched = 0;
  const runRepo = ctx.repoContext.workflowRunRepo;
  for (const workflow of await ctx.repoContext.workflowRepo.findAll()) {
    if (options.isStopping?.()) break;
    let suspended;
    try {
      const listed = await listSuspendedRuns(
        runRepo,
        workflow.id,
        options.signal,
      );
      if (listed === STOPPED) break;
      suspended = listed;
    } catch (error) {
      if (options.signal?.aborted) break;
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
          options.now,
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

/**
 * a listing the signal aborts is let go: a rebuild or repair stops at the next
 * record if no other reader needs it; shared work and plain reads finish
 * without holding up shutdown
 */
async function listSuspendedRuns(
  runRepo: ConnectionContext["repoContext"]["workflowRunRepo"],
  workflowId: WorkflowId,
  signal: AbortSignal | undefined,
): Promise<WorkflowRunSummary[] | typeof STOPPED> {
  const listing = runRepo.findSummariesByStatus(
    workflowId,
    "suspended",
    signal,
  );
  if (!signal) return await listing;
  const { stopped, release } = stoppedBy(signal);
  try {
    return await untilStopped(listing, stopped);
  } finally {
    release();
  }
}

/**
 * removes pending signals nothing will take, which gather in serve as key
 * signals are held there; reads only key records so it is safe on every
 * datastore; never throws, a failed sweep is retried
 */
export async function sweepHeldSignals(
  ctx: Pick<ConnectionContext, "repoContext">,
  now: Date = new Date(),
): Promise<number> {
  const waits = ctx.repoContext.signalWaits;
  if (!waits?.supported) return 0;
  try {
    return await sweepPendingSignals(waits.store, now);
  } catch (error) {
    logger.warn("Could not sweep pending signals: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * a lapse stays as its slot's highest record until claimed, so each sweep
 * rereads it; nothing needs it prompt, so it runs far less often than the
 * continuation pass
 */
export const HELD_SIGNAL_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * runs on the first call and then at most every intervalMs; the last sweep time
 * is per process; a call timed before it means the clock was set back and
 * sweeps, so the schedule never stalls
 */
export function heldSignalSweeper(
  intervalMs: number = HELD_SIGNAL_SWEEP_INTERVAL_MS,
): (
  ctx: Pick<ConnectionContext, "repoContext">,
  now?: Date,
) => Promise<number> {
  let last: number | undefined;
  return async (ctx, now = new Date()) => {
    const since = last === undefined ? intervalMs : now.getTime() - last;
    if (since >= 0 && since < intervalMs) return 0;
    last = now.getTime();
    return await sweepHeldSignals(ctx, now);
  };
}

export interface ContinuationSweepDeps {
  readonly intervalMs: number;
  /**
   * Run the boot pass and no other. Set on a synced datastore whose run
   * records cannot be compared with the remote: after boot a copy of a run
   * can be behind, and a pass would resume it.
   */
  readonly bootPassOnly?: boolean;
  sweep(
    pass: { boot: boolean; isStopping: () => boolean; signal: AbortSignal },
  ): Promise<ContinuationSweepResult>;
}

export type ContinuationSweepStart =
  | "start"
  | "disabled"
  /**
   * A synced datastore with no continuation claims every instance reads: no
   * shared control-plane store, or one that cannot create a record
   * atomically. The claim is all that keeps two instances there from
   * resuming one run from their own copies of it.
   */
  | "no_shared_claims"
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

export class ContinuationSweepService {
  readonly #deps: ContinuationSweepDeps;
  readonly #abort = new AbortController();
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
    if (this.#deps.bootPassOnly) {
      logger.info("Starting continuation sweep (boot pass only)");
    } else {
      logger.info(
        "Starting continuation sweep (interval: {interval}s)",
        { interval: this.#deps.intervalMs / 1000 },
      );
    }
    void this.#passThenSchedule();
  }

  /**
   * stops the schedule and waits for a pass in flight; the pass lets go of its
   * run listing at once so an index rebuild cannot hold shutdown, but a run
   * being continued is waited for so its claim is released
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#abort.abort();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#running) await this.#running;
  }

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
        signal: this.#abort.signal,
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
    if (this.#disposed || this.#deps.bootPassOnly) return;
    this.#timer = runDetached(() =>
      setTimeout(() => {
        void this.#passThenSchedule();
      }, this.#deps.intervalMs)
    );
    Deno.unrefTimer(this.#timer);
  }
}

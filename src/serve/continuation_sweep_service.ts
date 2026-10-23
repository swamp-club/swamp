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
 *
 * It is also what notices a deadline under serve (swamp-club#3109): a run
 * held back only by a wait for a signal that is past its deadline has that
 * wait settled as timed out, and continues.
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
 * hydration. On a synced datastore a run is also compared with the remote
 * before it resumes, where the sync service can read it (`fetchContent`).
 */
export async function sweepContinuations(
  ctx: ConnectionContext,
  options: {
    takeover: boolean;
    isStopping?: () => boolean;
    /**
     * Aborts the listing of a workflow's suspended runs: a rebuild or repair
     * of its run index stops between records and writes no index, and the
     * pass stops waiting for the listing at once, even one queued behind
     * another reader of the index (swamp-club#3472).
     */
    signal?: AbortSignal;
    /** The clock deadlines and backoffs are read against, for tests. */
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
 * A workflow's suspended runs, or {@link STOPPED} once `signal` aborts
 * first. The listing is then let go: a rebuild or repair stops at the next
 * record if no other reader needs it. Shared work and a plain read of the
 * index finish without holding up the sweep's shutdown.
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
 * Removes the pending signals nothing will take (swamp-club#3212): a signal
 * by key is held through serve, so serve is where they gather, and nothing
 * else here runs the wait-record sweep. It reads key records and never a run
 * record, so it is safe on every datastore. Never throws: a sweep that fails
 * is logged, and the next one tries again.
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
 * How often serve sweeps pending signals. A lapse stays as the highest
 * record of its slot until the slot is claimed, so every sweep reads each
 * such slot again, for good. Nothing waits on the sweep being prompt: a
 * signal lapses a day after its age limit, and whoever stores a signal over
 * another removes the one below. So it runs far less often than the
 * continuation pass it rides on (swamp-club#3308).
 */
export const HELD_SIGNAL_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * A {@link sweepHeldSignals} that runs on the first call and then no more
 * often than every `intervalMs`, for calling with each continuation pass.
 * A call that is not due reads nothing and returns 0. The time of the last
 * sweep is kept here, in this process: every instance keeps its own. A call
 * timed before the last sweep means the clock was set back, and sweeps: the
 * schedule must not stand still until the clock has caught up.
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
  /**
   * One pass; `boot` is true for the first pass after the server started.
   * `signal` aborts when the sweep is disposed.
   */
  sweep(
    pass: { boot: boolean; isStopping: () => boolean; signal: AbortSignal },
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
   * Stops the schedule and waits for a pass in flight. The pass lets go of
   * its listing of suspended runs at once (swamp-club#3472): a run index
   * rebuild must not hold shutdown. A run it is continuing is still waited
   * for, so the claim it took is released while this instance is live.
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

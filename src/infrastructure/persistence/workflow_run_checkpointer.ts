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
 * The {@link RunCheckpointer} of a repository context (swamp-club#3587): on
 * a v3 context each checkpoint commits what the units open around the save
 * have staged; on a v2 context it commits nothing, so a v2 run never pushes
 * mid-run.
 *
 * @module
 */

import { hostname } from "node:os";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import type { RunCheckpointer } from "../../domain/workflows/run_checkpointer.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { getSwampLogger } from "../logging/logger.ts";
import {
  checkpointOpenUnitOfWork,
  rootCommittedBeforeThrowing,
} from "./repo_unit_of_work.ts";
import type { RepositoryContext } from "./repository_factory.ts";

const logger = getSwampLogger(["workflow", "checkpoint"]);

/**
 * The least time between two checkpoints' starts. Each checkpoint stores the
 * whole run record, which grows with every step, so one per save would store
 * a 200-step run's record some 400 times (swamp-club#3587); a crash loses at
 * most about this long of a run's progress.
 */
export const RUN_CHECKPOINT_INTERVAL_MS = 2_000;

/**
 * Checkpoints one operation's workflow runs. A save checkpoints at once
 * when none has started for {@link RUN_CHECKPOINT_INTERVAL_MS}, or when it
 * ends a top-level run (any status but pending or running); otherwise
 * one trailing checkpoint starts when that interval ends, so the latest save
 * always lands within about one interval. One is in flight at a time, and
 * the saves made while it runs share the next one. {@link close} cancels or
 * waits for the trailing checkpoint; call it once the operation's root has
 * ended.
 *
 * One checkpointer serves one operation, whose runs save through one chain
 * of open units: the run's use-case unit, which nested child runs and
 * parallel steps share. A checkpoint commits what that chain staged, and
 * counts every save made before it started as committed.
 */
export class WorkflowRunCheckpointer implements RunCheckpointer {
  readonly #repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">;
  /** Numbers each save, so a checkpoint knows which saves it covers. */
  #saves = 0;
  /** The last save a checkpoint committed. */
  #committedThrough = 0;
  /** Each run's first and latest save. */
  readonly #runs = new Map<string, { first: number; latest: number }>();
  #current: Promise<void> | undefined;
  #next: Promise<void> | undefined;
  /** A refusal stops checkpoints; the root settles it when it ends. */
  #refused = false;
  readonly #intervalMs: number;
  readonly #now: () => number;
  /** When the last checkpoint started, epoch milliseconds. */
  #lastStarted = Number.NEGATIVE_INFINITY;
  #trailingTimer: ReturnType<typeof setTimeout> | undefined;
  /** The trailing checkpoint once it has started; it never rejects. */
  #trailing: Promise<void> | undefined;
  #closed = false;
  /** A failure is warned about once; repeats go to debug. */
  #warnedFailure = false;

  constructor(
    repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
    options: { intervalMs?: number; now?: () => number } = {},
  ) {
    this.#repoContext = repoContext;
    this.#intervalMs = options.intervalMs ?? RUN_CHECKPOINT_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }

  async checkpoint(run: WorkflowRun): Promise<void> {
    const save = ++this.#saves;
    const seen = this.#runs.get(run.id);
    this.#runs.set(run.id, { first: seen?.first ?? save, latest: save });
    if (this.#refused || this.#closed) return;
    // A top-level run's last save commits at once, so whether its final
    // record landed is known before its root ends (see
    // restoreUncommittedRuns). A nested child's is covered by its parent's,
    // which comes later, so many child steps do not each force a commit.
    const ended = run.status !== "pending" && run.status !== "running" &&
      run.parentRun === undefined;
    if (ended && this.#trailingTimer !== undefined) {
      clearTimeout(this.#trailingTimer);
      this.#trailingTimer = undefined;
    }
    if (!ended && this.#trailingTimer !== undefined) return;
    const wait = this.#lastStarted + this.#intervalMs - this.#now();
    if (ended || wait <= 0) {
      await this.#schedule();
      return;
    }
    // Started inside the save's unit scope, so the timer's checkpoint finds
    // the run's open units as the save would.
    this.#trailingTimer = setTimeout(() => {
      this.#trailingTimer = undefined;
      this.#trailing = this.#schedule();
    }, wait);
  }

  /**
   * Cancels a trailing checkpoint not yet started and waits for one in
   * flight. The root's own commit lands what it would have.
   */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#trailingTimer !== undefined) {
      clearTimeout(this.#trailingTimer);
      this.#trailingTimer = undefined;
    }
    await this.#trailing;
    await this.#next;
    await this.#current;
  }

  /**
   * After the operation's root failed to end, puts back to `running` the
   * tracker rows of runs this process completed whose latest save no
   * checkpoint committed, when an earlier one did. Their committed record
   * still says `running`, and only a row that says so too, with this
   * process's pid, lets `workflow recover`, `run doctor --fix` and serve's
   * reaper settle the run once this process is gone. `rootError` is what
   * the root threw; a root that committed before throwing it leaves nothing
   * to reopen. Closes the
   * checkpointer first. Never rejects, since it runs while the root's error
   * propagates; resolves with the run ids put back.
   */
  async restoreUncommittedRuns(
    tracker: () => Pick<RunTrackerRepository, "reopenCompleted"> | undefined,
    rootError: unknown,
  ): Promise<string[]> {
    await this.close();
    // A refusal settled with onRefused is thrown after the root committed
    // each run's reconciled final record: nothing is left to reopen.
    if (rootCommittedBeforeThrowing(this.#repoContext, rootError)) return [];
    const restored: string[] = [];
    try {
      const uncommitted = [...this.#runs].filter(([, saves]) =>
        saves.first <= this.#committedThrough &&
        saves.latest > this.#committedThrough
      );
      const store = uncommitted.length === 0 ? undefined : tracker();
      for (const [runId] of store === undefined ? [] : uncommitted) {
        if (store!.reopenCompleted(runId, Deno.pid, hostname())) {
          restored.push(runId);
        }
      }
    } catch (error) {
      logger
        .warn`Could not mark the uncommitted workflow runs for swamp workflow recover: ${error}`;
    }
    if (restored.length > 0) {
      logger
        .warn`The final record of ${restored.length} workflow run(s) was not committed; run swamp workflow recover once this process has exited to settle them: ${
        restored.join(", ")
      }`;
    }
    return restored;
  }

  #schedule(): Promise<void> {
    // Between a checkpoint's end and the start of the one queued after it,
    // a new save joins the queued one rather than starting a third.
    if (this.#next !== undefined) return this.#next;
    if (this.#current === undefined) {
      this.#current = this.#start();
      return this.#current;
    }
    this.#next ??= this.#current.then(() => {
      this.#next = undefined;
      this.#current = this.#start();
      return this.#current;
    });
    return this.#next;
  }

  #start(): Promise<void> {
    const covers = this.#saves;
    this.#lastStarted = this.#now();
    const started = (async () => {
      if (this.#refused) return;
      try {
        const outcome = await checkpointOpenUnitOfWork(this.#repoContext);
        if (outcome === "committed") {
          this.#committedThrough = Math.max(this.#committedThrough, covers);
        } else if (outcome === "refused") {
          this.#refused = true;
          logger
            .warn`A workflow run checkpoint was refused; the run's records are committed or discarded when it ends`;
        }
      } catch (error) {
        if (this.#warnedFailure) {
          logger
            .debug`A workflow run checkpoint failed again: ${error}`;
        } else {
          this.#warnedFailure = true;
          logger
            .warn`A workflow run checkpoint failed; the run goes on and its end commit tries again: ${error}`;
        }
      }
    })();
    const current: Promise<void> = started.finally(() => {
      if (this.#current === current) this.#current = undefined;
    });
    return current;
  }
}

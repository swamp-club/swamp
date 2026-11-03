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

import { hostname } from "node:os";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import type { RunCheckpointer } from "../../domain/workflows/run_checkpointer.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { getSwampLogger } from "../logging/logger.ts";
import {
  appendToOpenUnitOfWork,
  checkpointOpenUnitOfWork,
  commitsThroughCommitLog,
  rootCommittedBeforeThrowing,
} from "./repo_unit_of_work.ts";
import {
  StepStart,
  StepStartUnrecordedError,
} from "../../domain/workflows/step_start.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

import type { YamlWorkflowRunRepository } from "./yaml_workflow_run_repository.ts";
import type { RepositoryContext } from "./repository_factory.ts";

const logger = getSwampLogger(["workflow", "checkpoint"]);

/**
 * each checkpoint stores the whole run record, so one per save would store it
 * hundreds of times; a crash loses at most about this long of progress
 */
export const RUN_CHECKPOINT_INTERVAL_MS = 2_000;

/**
 * a save checkpoints at once if none started within the interval or a
 * top-level run ends; otherwise one trailing checkpoint starts when the
 * interval ends. One in flight at a time
 */
export class WorkflowRunCheckpointer implements RunCheckpointer {
  readonly #repoContext: CheckpointerContext;
  #saves = 0;
  #committedThrough = 0;
  readonly #runs = new Map<
    string,
    {
      first: number;
      latest: number;
      unknownSteps: readonly string[];
      startedSteps: readonly string[];
    }
  >();
  readonly #checkpointedStarts = new Map<string, ReadonlySet<string>>();
  readonly #committedUnknownSteps = new Map<string, readonly string[]>();
  /** a run first seen already running, in a new process, counts as a move into running */
  readonly #statuses = new Map<string, string>();
  /** the starts this process committed, by run, with the save that made each */
  readonly #journal = new Map<
    string,
    { readonly start: StepStart; readonly save: number }[]
  >();
  readonly #appending = new Map<string, Promise<void>>();
  /** serve does not take step starts: starts commit the whole record */
  #journalRefused = false;
  #current: Promise<void> | undefined;
  #next: Promise<void> | undefined;
  #refused = false;
  readonly #intervalMs: number;
  readonly #now: () => number;
  #lastStarted = Number.NEGATIVE_INFINITY;
  #trailingTimer: ReturnType<typeof setTimeout> | undefined;
  #trailing: Promise<void> | undefined;
  #closed = false;
  #warnedFailure = false;

  constructor(
    repoContext: CheckpointerContext,
    options: { intervalMs?: number; now?: () => number } = {},
  ) {
    this.#repoContext = repoContext;
    this.#intervalMs = options.intervalMs ?? RUN_CHECKPOINT_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }

  async checkpoint(run: WorkflowRun): Promise<void> {
    const save = ++this.#saves;
    const seen = this.#runs.get(run.id);
    const startedSteps = runningStepsOf(run);
    this.#runs.set(run.id, {
      first: seen?.first ?? save,
      latest: save,
      unknownSteps: run.unknownStepsIfOrphaned(this.#startsOf(run.id)),
      startedSteps,
    });
    const before = this.#statuses.get(run.id);
    this.#statuses.set(run.id, run.status);
    if (this.#refused || this.#closed) return;
    const checkpointed = this.#checkpointedStarts.get(run.id);
    const newStart = startedSteps.some((step) => !checkpointed?.has(step));
    const journal = this.#usesJournal();
    if (journal) {
      if (run.status === "running" && before !== "running") {
        await this.#appendRecord(run);
      }
      if (newStart && !this.#journalRefused) {
        await this.#serialized(run.id, () => this.#appendStarts(run, save));
      }
    }
    // A step that ends while a sibling runs has no next start to carry its
    // end, so recovery would count it with the sibling as maybe-run; with a
    // journal that end is paced, and recovery asks about it.
    const endedBesideSibling = (!journal || this.#journalRefused) &&
      startedSteps.length > 0 &&
      [...checkpointed ?? []].some((step) => !startedSteps.includes(step));
    // a top-level run's last save commits at once, so whether its final record
    // landed is known before its root ends; a nested child's is covered by its
    // parent's
    const ended = run.status !== "pending" && run.status !== "running" &&
      run.parentRun === undefined;
    const atOnce = ended || endedBesideSibling ||
      (newStart && (!journal || this.#journalRefused));
    if (atOnce && this.#trailingTimer !== undefined) {
      clearTimeout(this.#trailingTimer);
      this.#trailingTimer = undefined;
    }
    if (!atOnce && this.#trailingTimer !== undefined) return;
    const wait = this.#lastStarted + this.#intervalMs - this.#now();
    if (atOnce || wait <= 0) {
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

  /** a run's appends wait on each other, so parallel steps never append one start twice */
  async #serialized(runId: string, fn: () => Promise<void>): Promise<void> {
    const before = this.#appending.get(runId) ?? Promise.resolve();
    const run = before.then(fn);
    const tail = run.catch(() => {});
    this.#appending.set(runId, tail);
    try {
      await run;
    } finally {
      if (this.#appending.get(runId) === tail) this.#appending.delete(runId);
    }
  }

  #usesJournal(): boolean {
    return this.#repoContext.workflowRunRepo !== undefined &&
      commitsThroughCommitLog(this.#repoContext);
  }

  #startsOf(runId: string): StepStart[] {
    return (this.#journal.get(runId) ?? []).map((entry) => entry.start);
  }

  /** the run's own record, so its starts never land before it */
  async #appendRecord(run: WorkflowRun): Promise<void> {
    const repo = this.#repoContext.workflowRunRepo!;
    try {
      const change = await repo.recordChange(
        createWorkflowId(run.workflowId),
        run.id,
      );
      if (change === undefined) return;
      const outcome = await appendToOpenUnitOfWork(this.#repoContext, [
        change,
      ]);
      if (outcome === "unsupported") this.#journalRefused = true;
    } catch (error) {
      throw new StepStartUnrecordedError(error, {
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        runId: run.id,
      });
    }
  }

  async #appendStarts(run: WorkflowRun, save: number): Promise<void> {
    const repo = this.#repoContext.workflowRunRepo!;
    const done = new Set(this.#checkpointedStarts.get(run.id) ?? []);
    const running = new Set(runningStepsOf(run));
    for (const job of run.jobs) {
      for (const step of job.steps) {
        if (step.status !== "running") continue;
        const key = startKeyOf(job.jobName, step);
        if (done.has(key)) continue;
        const start = StepStart.create({
          workflowId: run.workflowId,
          runId: run.id,
          jobName: job.jobName,
          stepName: step.stepName,
          startedAt: step.startedAt?.getTime() ?? this.#now(),
        });
        try {
          const outcome = await appendToOpenUnitOfWork(this.#repoContext, [
            await repo.writeStepStart(start),
          ]);
          if (outcome === "unsupported") {
            this.#journalRefused = true;
            return;
          }
          // with no open unit nothing commits, a start no more than the rest
          if (outcome === "no-unit") {
            done.add(key);
            continue;
          }
        } catch (error) {
          throw new StepStartUnrecordedError(error, {
            workflowId: run.workflowId,
            workflowName: run.workflowName,
            runId: run.id,
            stepName: step.stepName,
            jobName: job.jobName,
          });
        }
        // Only a committed start counts: one that failed is started again.
        done.add(key);
        const journal = this.#journal.get(run.id) ?? [];
        journal.push({ start, save });
        this.#journal.set(run.id, journal);
        this.#committedUnknownSteps.set(run.id, [
          ...new Set([
            ...this.#committedUnknownSteps.get(run.id) ?? [],
            step.stepName,
          ]),
        ]);
      }
    }
    this.#checkpointedStarts.set(
      run.id,
      new Set([...done].filter((key) => running.has(key))),
    );
  }

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
   * puts back to running the tracker rows of completed runs whose latest save
   * no checkpoint committed, so recovery and the reaper can settle them once
   * this process is gone; never rejects
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

  committedLatest(runId: string): boolean {
    const saves = this.#runs.get(runId);
    return saves !== undefined && saves.latest <= this.#committedThrough;
  }

  /**
   * the steps a recovery would find in flight in the run's last committed
   * record, which it must be told to accept
   */
  committedUnknownSteps(runId: string): readonly string[] | undefined {
    return this.#committedUnknownSteps.get(runId);
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
    const unknownSteps = [...this.#runs].map(([runId, saves]) =>
      [runId, saves.unknownSteps] as const
    );
    const startedSteps = [...this.#runs].map(([runId, saves]) =>
      [runId, saves.startedSteps] as const
    );
    const wholeRecordStarts = !this.#usesJournal() || this.#journalRefused;
    this.#lastStarted = this.#now();
    const started = (async () => {
      if (this.#refused) return;
      try {
        const outcome = await checkpointOpenUnitOfWork(this.#repoContext);
        if (outcome === "committed") {
          // only a committed start counts: a failed one checkpoints again
          if (wholeRecordStarts) {
            for (const [runId, steps] of startedSteps) {
              this.#checkpointedStarts.set(runId, new Set(steps));
            }
          }
          if (covers > this.#committedThrough) {
            for (const [runId, steps] of unknownSteps) {
              // starts committed after the save this checkpoint covers are in
              // flight as far as a recovery reading it can tell
              const later = (this.#journal.get(runId) ?? [])
                .filter((entry) => entry.save > covers)
                .map((entry) => entry.start.stepName);
              this.#committedUnknownSteps.set(runId, [
                ...new Set([...steps, ...later]),
              ]);
            }
          }
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

/** a step run again keeps its name but not its start time */
function runningStepsOf(run: WorkflowRun): string[] {
  return run.jobs.flatMap((job) =>
    job.steps
      .filter((step) => step.status === "running")
      .map((step) => startKeyOf(job.jobName, step))
  );
}

function startKeyOf(
  jobName: string,
  step: { readonly stepName: string; readonly startedAt?: Date },
): string {
  return `${jobName}/${step.stepName}@${step.startedAt?.getTime() ?? ""}`;
}

type CheckpointerContext =
  & Pick<RepositoryContext, "markDirty" | "commitLog">
  & {
    readonly workflowRunRepo?: Pick<
      YamlWorkflowRunRepository,
      "recordChange" | "writeStepStart"
    >;
  };

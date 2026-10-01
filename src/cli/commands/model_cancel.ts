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

import { Command } from "@cliffy/command";
import type { Logger } from "@logtape/logtape";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  isProcessAlive,
  killProcessTree,
} from "../../infrastructure/process/process_kill.ts";
import { KILL_GRACE_MS } from "../../infrastructure/process/process_executor.ts";
import type {
  ActiveRun,
  ActiveRunStatus,
} from "../../domain/models/active_run.ts";
import { maxOf } from "../../domain/array_extrema.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import { OWNER_STOP_GRACE_MS } from "./workflow_cancel.ts";
import {
  DEFAULT_STALE_TTL_MS,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * How long cancel waits for a method run's owning process to exit after
 * SIGTERM before it SIGKILLs it. The owner aborts the method, whose shell step
 * gets {@link KILL_GRACE_MS} between SIGTERM and SIGKILL, and then saves the
 * cancelled output, releases its locks and syncs; the margin covers that.
 */
export const METHOD_OWNER_STOP_GRACE_MS = KILL_GRACE_MS + 7_000;

/** A process cancel stops, and how long it waits before SIGKILL. */
export interface OwnerStop {
  pid: number;
  maxWaitMs: number;
}

export interface CancelModelMethodRunsDeps {
  tracker: Pick<
    RunTrackerRepository,
    "findAllRunning" | "findById" | "complete" | "recordCancelReason"
  >;
  killProcess?: (
    pid: number,
    options: { maxWaitMs: number },
  ) => Promise<boolean>;
  /** Called with the owners about to be stopped, before waiting on them. */
  onStopping?: (stops: readonly OwnerStop[]) => void;
}

/**
 * The grace for stopping `pid`. A process that also owns a running workflow
 * run runs that run's cleanup steps when it is cancelled, so it gets the
 * workflow cancel grace; any other owner gets
 * {@link METHOD_OWNER_STOP_GRACE_MS}.
 */
export function ownerStopGraceMs(
  pid: number,
  runningRows: readonly ActiveRun[],
): number {
  return runningRows.some((r) => r.runKind === "workflow" && r.pid === pid)
    ? OWNER_STOP_GRACE_MS
    : METHOD_OWNER_STOP_GRACE_MS;
}

/** How a method run ended once cancel was done with it. */
export interface MethodRunCancelOutcome {
  run: ActiveRun;
  /** `cancelled`, or how the run finished before the cancel took effect. */
  status: ActiveRunStatus;
}

/**
 * Cancels method runs: stops their owning processes together, each process
 * once, since the steps of one workflow share its process and a second
 * SIGTERM makes an owner exit at once. Then completes each tracker row as
 * cancelled. An owner that stopped in time completed its row itself, without
 * the reason, so the reason is recorded on it afterwards. Returns each run's
 * final status: a run its owner finished another way during the wait keeps
 * that status. If stopping an owner fails, the other owners are still
 * stopped and their runs completed, then the first failure is thrown.
 */
export async function cancelModelMethodRuns(
  runs: readonly ActiveRun[],
  reason: string | undefined,
  { tracker, killProcess = killProcessTree, onStopping }:
    CancelModelMethodRunsDeps,
): Promise<MethodRunCancelOutcome[]> {
  const runningRows = tracker.findAllRunning();
  const pids = new Set<number>();
  for (const run of runs) {
    if (run.pid !== Deno.pid) pids.add(run.pid);
  }
  const stops = [...pids].map((pid) => ({
    pid,
    maxWaitMs: ownerStopGraceMs(pid, runningRows),
  }));
  if (stops.length > 0) onStopping?.(stops);
  // Every stop is waited out, so none is left running when one fails.
  const settled = await Promise.allSettled(
    stops.map(({ pid, maxWaitMs }) => killProcess(pid, { maxWaitMs })),
  );
  const unstopped = new Set<number>();
  const errors: unknown[] = [];
  settled.forEach((result, i) => {
    if (result.status === "rejected") {
      unstopped.add(stops[i].pid);
      errors.push(result.reason);
    }
  });

  // A run whose owner could not be stopped is left running.
  const outcomes = runs.filter((run) => !unstopped.has(run.pid)).map((run) => {
    tracker.complete(run.id, "cancelled", reason);
    if (reason !== undefined) tracker.recordCancelReason(run.id, reason);
    // Rows are purged only days after they complete, so the row is still
    // there; the fallback is the status just written.
    return { run, status: tracker.findById(run.id)?.status ?? "cancelled" };
  });
  if (errors.length > 0) throw errors[0];
  return outcomes;
}

/** A method run a live `swamp serve` owns, which cancel must not stop. */
export interface ServeOwnedMethodRun {
  run: ActiveRun;
  /** The owning serve instance. */
  instanceId: string;
}

/**
 * The serve instance that owns `run`: its own instance id, or else the one
 * on a serve-owned workflow row that shares its pid and host. The fallback
 * covers step rows written by a serve binary that predates instance ids on
 * method rows.
 */
function owningServeInstance(
  run: ActiveRun,
  runningRows: readonly ActiveRun[],
): string | undefined {
  if (run.isServeOwned) return run.instanceId;
  return runningRows.find((r) =>
    r.runKind === "workflow" && r.isServeOwned && r.pid === run.pid &&
    r.hostname === run.hostname
  )?.instanceId;
}

/**
 * Splits method runs into those cancel may stop and those a live
 * `swamp serve` owns. A serve-owned run's pid is the serve process, so
 * stopping it would shut down the whole server. A serve-owned run whose
 * owner is dead is cancellable: there is nothing left to signal, and cancel
 * only completes its row.
 */
export function splitServeOwnedRuns(
  runs: readonly ActiveRun[],
  runningRows: readonly ActiveRun[],
  isAlive: (pid: number) => boolean = isProcessAlive,
): { cancellable: ActiveRun[]; serveOwned: ServeOwnedMethodRun[] } {
  const cancellable: ActiveRun[] = [];
  const serveOwned: ServeOwnedMethodRun[] = [];
  for (const run of runs) {
    const instanceId = owningServeInstance(run, runningRows);
    if (instanceId !== undefined && isAlive(run.pid)) {
      serveOwned.push({ run, instanceId });
    } else {
      cancellable.push(run);
    }
  }
  return { cancellable, serveOwned };
}

/** Which of a model's method runs cancel stops, and which it skips. */
export interface MethodRunSelection {
  /** The latest run cancel may stop; undefined when serve owns them all. */
  run: ActiveRun | undefined;
  /** Runs a live `swamp serve` owns, newest first. */
  skipped: ServeOwnedMethodRun[];
}

/** Selects the latest of a model's method runs that cancel may stop. */
export function selectMethodRunToCancel(
  runs: readonly ActiveRun[],
  runningRows: readonly ActiveRun[],
  isAlive: (pid: number) => boolean = isProcessAlive,
): MethodRunSelection {
  const newestFirst = [...runs].sort((a, b) =>
    b.startedAt.getTime() - a.startedAt.getTime()
  );
  const { cancellable, serveOwned } = splitServeOwnedRuns(
    newestFirst,
    runningRows,
    isAlive,
  );
  return { run: cancellable[0], skipped: serveOwned };
}

function methodRunFields(run: ActiveRun) {
  return {
    id: run.id,
    type: run.modelType ?? "unknown",
    method: run.methodName ?? "unknown",
  };
}

function skippedFields({ run, instanceId }: ServeOwnedMethodRun) {
  return { ...methodRunFields(run), instanceId };
}

/** How to cancel a serve-owned method run, which cancel will not stop. */
const SERVE_CANCEL_GUIDANCE =
  "for a workflow step, cancel its workflow run with swamp workflow cancel --run <workflow-run-id> --server <url>; " +
  "for a direct method run, stop the client that started it";

function warnServeOwnedSkipped(
  logger: Logger,
  skipped: readonly ServeOwnedMethodRun[],
): void {
  if (skipped.length === 0) return;
  logger
    .warn`Skipped ${skipped.length} method run(s) owned by a swamp serve instance, which cancel never stops`;
  for (const s of skipped.map(skippedFields)) {
    logger.warn`  ${s.type}/${s.method} (${s.id}) on instance ${s.instanceId}`;
  }
  // A plain message, so the guidance is not quoted as an interpolated value.
  logger.warn(`To cancel one: ${SERVE_CANCEL_GUIDANCE}`);
}

/**
 * The owners in `stops` still running, and the longest cancel will wait on
 * them in seconds; undefined when none is running.
 */
function liveStops(
  stops: readonly OwnerStop[],
): { live: OwnerStop[]; seconds: number } | undefined {
  const live = stops.filter(({ pid }) => isProcessAlive(pid));
  const longest = maxOf(live.map((s) => s.maxWaitMs));
  if (longest === undefined) return undefined;
  return { live, seconds: longest / 1000 };
}

export const modelCancelCommand = new Command()
  .name("cancel")
  .description("Cancel a running model method run")
  .example("Cancel a model run", "swamp model cancel my-server")
  .example(
    "Cancel with reason",
    "swamp model cancel my-server --reason 'No longer needed'",
  )
  .example("Cancel all running", "swamp model cancel --all")
  .arguments("[model_id_or_name:model_name]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--all",
    "Cancel all running model method runs, skipping runs a live swamp serve owns",
  )
  .option("--reason <reason:string>", "Reason for cancellation")
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["model", "cancel"]);

    if (!options.all && !modelIdOrName) {
      throw new UserError(
        "Provide a model name or ID, or use --all to cancel all running runs",
      );
    }

    const { repoDir, repoContext } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const reason = options.reason as string | undefined;
    const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));

    try {
      runTracker.reapStaleRuns(DEFAULT_STALE_TTL_MS);

      if (options.all) {
        const runningRows = runTracker.findAllRunning();
        const { cancellable, serveOwned } = splitServeOwnedRuns(
          runningRows.filter((r) => r.runKind === "model_method"),
          runningRows,
        );
        const skipped = serveOwned.map(skippedFields);

        if (cancellable.length === 0) {
          if (cliCtx.outputMode === "json") {
            console.log(
              JSON.stringify({ cancelled: [], finished: [], skipped }),
            );
          } else if (serveOwned.length === 0) {
            cliCtx.logger.info("No running model method runs to cancel.");
          } else {
            warnServeOwnedSkipped(cliCtx.logger, serveOwned);
          }
          return;
        }

        const outcomes = await cancelModelMethodRuns(cancellable, reason, {
          tracker: runTracker,
          onStopping: (stops) => {
            const waiting = liveStops(stops);
            if (!waiting || cliCtx.outputMode === "json") return;
            const count = cancellable.filter((r) =>
              waiting.live.some(({ pid }) =>
                pid === r.pid
              )
            ).length;
            cliCtx.logger
              .info`Stopping ${count} method run(s); waiting up to ${waiting.seconds}s for them to stop (cancel again to stop immediately)`;
          },
        });
        const cancelled = outcomes.filter((o) => o.status === "cancelled")
          .map(({ run }) => methodRunFields(run));
        const finished = outcomes.filter((o) => o.status !== "cancelled")
          .map(({ run, status }) => ({ ...methodRunFields(run), status }));

        if (cliCtx.outputMode === "json") {
          console.log(JSON.stringify({
            cancelled,
            finished,
            skipped,
            reason: reason ?? null,
          }));
        } else {
          if (cancelled.length > 0) {
            cliCtx.logger
              .info`Cancelled ${cancelled.length} running model method run(s)`;
            for (const c of cancelled) {
              cliCtx.logger.info`  ${c.type}/${c.method} (${c.id})`;
            }
          }
          if (finished.length > 0) {
            cliCtx.logger
              .warn`${finished.length} method run(s) finished before the cancel took effect`;
            for (const f of finished) {
              cliCtx.logger
                .warn`  ${f.type}/${f.method} (${f.id}): ${f.status}`;
            }
          }
          warnServeOwnedSkipped(cliCtx.logger, serveOwned);
        }
        return;
      }

      // Cancel a specific model's running output
      const definitionRepo = repoContext.definitionRepo;
      const resolved = await definitionRepo.findByNameGlobal(modelIdOrName!);
      if (!resolved) {
        throw new UserError(
          `Model '${modelIdOrName}' not found`,
        );
      }

      const { definition, type } = resolved;

      const runningRows = runTracker.findAllRunning();
      const trackerRuns = runningRows.filter(
        (r) => r.modelType === type.normalized,
      );

      if (trackerRuns.length === 0) {
        throw new UserError(
          `No running method runs found for model '${definition.name}'`,
        );
      }

      const { run: latest, skipped } = selectMethodRunToCancel(
        trackerRuns,
        runningRows,
      );
      if (latest === undefined) {
        const [{ run, instanceId }] = skipped;
        throw new UserError(
          `Method run ${run.id} for model '${definition.name}' belongs to swamp serve instance ${instanceId} and cannot be cancelled locally. ` +
            `To cancel it: ${SERVE_CANCEL_GUIDANCE}.`,
        );
      }

      const [{ status }] = await cancelModelMethodRuns([latest], reason, {
        tracker: runTracker,
        onStopping: (stops) => {
          const waiting = liveStops(stops);
          if (!waiting || cliCtx.outputMode === "json") return;
          cliCtx.logger
            .info`Stopping method run ${latest.id}; waiting up to ${waiting.seconds}s for it to stop (cancel again to stop immediately)`;
        },
      });

      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify({
          id: latest.id,
          modelName: definition.name,
          type: type.normalized,
          method: latest.methodName ?? "unknown",
          status,
          reason: status === "cancelled" ? reason ?? null : null,
          skipped: skipped.map(skippedFields),
        }));
      } else if (status === "cancelled") {
        cliCtx.logger
          .info`Cancelled method run ${
          latest.methodName ?? "unknown"
        } for model ${definition.name} (${latest.id})`;
      } else {
        cliCtx.logger
          .warn`Method run ${
          latest.methodName ?? "unknown"
        } for model ${definition.name} (${latest.id}) finished as ${status} before the cancel took effect`;
      }
      if (cliCtx.outputMode !== "json") {
        warnServeOwnedSkipped(cliCtx.logger, skipped);
      }
    } finally {
      runTracker.close();
    }
  });

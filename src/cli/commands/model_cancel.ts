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
import type { ActiveRun } from "../../domain/models/active_run.ts";
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
    "findAllRunning" | "complete" | "recordCancelReason"
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

/**
 * Cancels method runs: stops their owning processes together, each process
 * once, since the steps of one workflow share its process and a second
 * SIGTERM makes an owner exit at once. Then completes each tracker row as
 * cancelled. An owner that stopped in time completed its row itself, without
 * the reason, so the reason is recorded on it afterwards.
 */
export async function cancelModelMethodRuns(
  runs: readonly ActiveRun[],
  reason: string | undefined,
  { tracker, killProcess = killProcessTree, onStopping }:
    CancelModelMethodRunsDeps,
): Promise<void> {
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
  await Promise.all(
    stops.map(({ pid, maxWaitMs }) => killProcess(pid, { maxWaitMs })),
  );

  for (const run of runs) {
    tracker.complete(run.id, "cancelled", reason);
    if (reason !== undefined) tracker.recordCancelReason(run.id, reason);
  }
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
  .option("--all", "Cancel all running model method runs")
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
        const trackerRuns = runTracker.findAllRunning().filter(
          (r) => r.runKind === "model_method",
        );

        if (trackerRuns.length === 0) {
          if (cliCtx.outputMode === "json") {
            console.log(JSON.stringify({ cancelled: [] }));
          } else {
            cliCtx.logger.info("No running model method runs to cancel.");
          }
          return;
        }

        await cancelModelMethodRuns(trackerRuns, reason, {
          tracker: runTracker,
          onStopping: (stops) => {
            const waiting = liveStops(stops);
            if (!waiting || cliCtx.outputMode === "json") return;
            const count = trackerRuns.filter((r) =>
              waiting.live.some(({ pid }) =>
                pid === r.pid
              )
            ).length;
            cliCtx.logger
              .info`Stopping ${count} method run(s); waiting up to ${waiting.seconds}s for them to stop (cancel again to stop immediately)`;
          },
        });
        const cancelled = trackerRuns.map((run) => ({
          id: run.id,
          type: run.modelType ?? "unknown",
          method: run.methodName ?? "unknown",
        }));

        if (cliCtx.outputMode === "json") {
          console.log(JSON.stringify({
            cancelled,
            reason: reason ?? null,
          }));
        } else {
          cliCtx.logger
            .info`Cancelled ${cancelled.length} running model method run(s)`;
          for (const c of cancelled) {
            cliCtx.logger.info`  ${c.type}/${c.method} (${c.id})`;
          }
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

      const trackerRuns = runTracker.findAllRunning().filter(
        (r) => r.modelType === type.normalized,
      );

      if (trackerRuns.length === 0) {
        throw new UserError(
          `No running method runs found for model '${definition.name}'`,
        );
      }

      const latest = trackerRuns.sort(
        (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
      )[0];

      await cancelModelMethodRuns([latest], reason, {
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
          status: "cancelled",
          reason: reason ?? null,
        }));
      } else {
        cliCtx.logger
          .info`Cancelled method run ${
          latest.methodName ?? "unknown"
        } for model ${definition.name} (${latest.id})`;
      }
    } finally {
      runTracker.close();
    }
  });

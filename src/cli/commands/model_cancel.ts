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
  type CommandSyntax,
  definitionArgument,
  definitionNameType,
  recordDefiningModule,
  withPreferredExample,
} from "./command_syntax.ts";
import {
  surfaceMethodNoun,
  surfaceNoun,
  surfaceNounCapitalized,
} from "../../presentation/command_surface.ts";
import type { Logger } from "@logtape/logtape";
import { hostname } from "node:os";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  createModelLock,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
} from "../repo_context.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
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
import type { ModelType } from "../../domain/models/model_type.ts";
import type { LockInfo } from "../../domain/datastore/distributed_lock.ts";
import { openCancelWriter, OWNER_STOP_GRACE_MS } from "./workflow_cancel.ts";
import {
  DEFAULT_STALE_TTL_MS,
  localOwnerLiveness,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import { OWNER_STOPPED_STEP_ERROR } from "../../domain/workflows/workflow_run.ts";
import {
  cancelOrphanedMethodRuns,
  type MethodRunOutputs,
  type OwnerLiveness,
  warnUnsettledMethodRuns,
} from "../../domain/workflows/orphaned_run_reaper.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * the owner aborts the method, whose shell step gets KILL_GRACE_MS between
 * SIGTERM and SIGKILL, then saves the cancelled output, releases its locks and
 * syncs; the margin covers that.
 */
export const METHOD_OWNER_STOP_GRACE_MS = KILL_GRACE_MS + 7_000;

export interface OwnerStop {
  pid: number;
  maxWaitMs: number;
}

export interface CancelModelMethodRunsDeps {
  tracker: Pick<
    RunTrackerRepository,
    "findAllRunning" | "findById" | "complete" | "recordCancelReason"
  >;
  outputRepo: MethodRunOutputs;
  liveness?: OwnerLiveness;
  killProcess?: (
    pid: number,
    options: { maxWaitMs: number },
  ) => Promise<boolean>;
  onStopping?: (stops: readonly OwnerStop[]) => void;
}

/**
 * a process that also owns a running workflow run runs that run's cleanup steps
 * when cancelled, so it gets the workflow cancel grace.
 */
export function ownerStopGraceMs(
  pid: number,
  runningRows: readonly ActiveRun[],
): number {
  return runningRows.some((r) => r.runKind === "workflow" && r.pid === pid)
    ? OWNER_STOP_GRACE_MS
    : METHOD_OWNER_STOP_GRACE_MS;
}

export interface MethodRunCancelOutcome {
  run: ActiveRun;
  status: ActiveRunStatus;
}

/**
 * stops owners together, each once (a second SIGTERM makes an owner exit at
 * once); a record left running by an owner killed after its grace is cancelled
 * with OWNER_STOPPED_STEP_ERROR
 */
export async function cancelModelMethodRuns(
  runs: readonly ActiveRun[],
  reason: string | undefined,
  deps: CancelModelMethodRunsDeps,
): Promise<MethodRunCancelOutcome[]> {
  return await settleStoppedMethodRuns(
    await stopMethodRunOwners(runs, deps),
    reason,
    deps,
  );
}

export interface StoppedMethodRuns {
  /** The runs whose owner stopped, or was this process. */
  stopped: ActiveRun[];
  /** Why an owner could not be stopped; its runs are left running. */
  errors: unknown[];
}

/** Needs no datastore writer, so cancel can stop an owner that holds it. */
export async function stopMethodRunOwners(
  runs: readonly ActiveRun[],
  {
    tracker,
    killProcess = killProcessTree,
    onStopping,
  }: Pick<
    CancelModelMethodRunsDeps,
    "tracker" | "killProcess" | "onStopping"
  >,
): Promise<StoppedMethodRuns> {
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
  return { stopped: runs.filter((run) => !unstopped.has(run.pid)), errors };
}

/**
 * the stopped runs whose owner died without saving them: only these need the
 * datastore writer to settle
 */
export function abandonedMethodRuns(
  stopped: readonly ActiveRun[],
  {
    tracker,
    liveness = localOwnerLiveness(),
  }: Pick<CancelModelMethodRunsDeps, "tracker" | "liveness">,
): ActiveRun[] {
  return stopped.filter((run) =>
    run.pid !== Deno.pid &&
    run.isLocalTo(liveness.hostname, liveness.instanceId) &&
    liveness.isDead(run.pid) &&
    tracker.findById(run.id)?.status === "running"
  );
}

export async function settleStoppedMethodRuns(
  { stopped, errors }: StoppedMethodRuns,
  reason: string | undefined,
  {
    tracker,
    outputRepo,
    liveness = localOwnerLiveness(),
  }: Pick<CancelModelMethodRunsDeps, "tracker" | "outputRepo" | "liveness">,
): Promise<MethodRunCancelOutcome[]> {
  const abandoned = abandonedMethodRuns(stopped, { tracker, liveness });
  // A record that cannot be read or saved does not stop the cancel: its row
  // is marked interrupted, so run doctor --fix settles it later.
  const { failed, errors: outputErrors } = await cancelOrphanedMethodRuns(
    outputRepo,
    abandoned,
    OWNER_STOPPED_STEP_ERROR,
  );
  warnUnsettledMethodRuns(failed.length, outputErrors);
  for (const run of failed) tracker.complete(run.id, "interrupted");

  const outcomes = stopped.map((run) => {
    tracker.complete(run.id, "cancelled", reason);
    if (reason !== undefined) tracker.recordCancelReason(run.id, reason);
    // Rows are purged only days after they complete, so the row is still
    // there; the fallback is the status just written.
    return { run, status: tracker.findById(run.id)?.status ?? "cancelled" };
  });
  if (errors.length > 0) throw errors[0];
  return outcomes;
}

export interface ServeOwnedMethodRun {
  run: ActiveRun;
  instanceId: string;
}

/**
 * falls back to the instance on a serve-owned workflow row sharing its pid and
 * host, for step rows written without an instance id.
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
 * a serve-owned run's pid is the serve process, so stopping it would shut down
 * the server; a dead owner on this host only has its row completed; another
 * host's pid says nothing, so it counts as live
 */
export function splitServeOwnedRuns(
  runs: readonly ActiveRun[],
  runningRows: readonly ActiveRun[],
  isAlive: (pid: number) => boolean = isProcessAlive,
  localHostname: string = hostname(),
): { cancellable: ActiveRun[]; serveOwned: ServeOwnedMethodRun[] } {
  const cancellable: ActiveRun[] = [];
  const serveOwned: ServeOwnedMethodRun[] = [];
  for (const run of runs) {
    const instanceId = owningServeInstance(run, runningRows);
    const ownerLive = run.hostname !== localHostname || isAlive(run.pid);
    if (instanceId !== undefined && ownerLive) {
      serveOwned.push({ run, instanceId });
    } else {
      cancellable.push(run);
    }
  }
  return { cancellable, serveOwned };
}

export interface MethodRunSelection {
  run: ActiveRun | undefined;
  skipped: ServeOwnedMethodRun[];
}

export function selectMethodRunToCancel(
  runs: readonly ActiveRun[],
  runningRows: readonly ActiveRun[],
  isAlive: (pid: number) => boolean = isProcessAlive,
  localHostname: string = hostname(),
): MethodRunSelection {
  const newestFirst = [...runs].sort((a, b) =>
    b.startedAt.getTime() - a.startedAt.getTime()
  );
  const { cancellable, serveOwned } = splitServeOwnedRuns(
    newestFirst,
    runningRows,
    isAlive,
    localHostname,
  );
  return { run: cancellable[0], skipped: serveOwned };
}

export interface ModelMethodRuns {
  runs: ActiveRun[];
  /**
   * Running rows of the model's type that name no definition and that
   * nothing ties to one, so none of them is selected.
   */
  unattributed: ActiveRun[];
}

export interface LegacyRunAttribution {
  own: ReadonlySet<string>;
  others: ReadonlySet<string>;
}

/**
 * selects by definition id, never by type alone. A row without a recorded
 * definition id is the model's only when legacy says so, and unattributed
 * unless legacy places it with another model.
 */
export function methodRunsOfModel(
  runningRows: readonly ActiveRun[],
  model: { definitionId: string; modelType: string },
  legacy: LegacyRunAttribution = { own: new Set(), others: new Set() },
): ModelMethodRuns {
  const ofType = runningRows.filter((r) =>
    r.runKind === "model_method" && r.modelType === model.modelType
  );
  return {
    runs: ofType.filter((r) =>
      r.definitionId === model.definitionId ||
      (r.definitionId === null && legacy.own.has(r.id))
    ),
    unattributed: ofType.filter((r) =>
      r.definitionId === null && !legacy.own.has(r.id) &&
      !legacy.others.has(r.id)
    ),
  };
}

export interface LegacyRunEvidence {
  outputs: Pick<MethodRunOutputs, "findByIds">;
  inspectModelLock: () => Promise<LockInfo | null>;
  logger: Logger;
}

/**
 * an unattributed row is attributed from its method-run record (only a workflow
 * step has one while running), else from the model's lock if its process holds
 * it and runs no other method
 */
export async function findMethodRunsOfModel(
  runningRows: readonly ActiveRun[],
  model: { definitionId: string; type: ModelType },
  evidence: LegacyRunEvidence,
): Promise<ModelMethodRuns> {
  const selector = {
    definitionId: model.definitionId,
    modelType: model.type.normalized,
  };
  const selected = methodRunsOfModel(runningRows, selector);
  const legacyRows = selected.unattributed;
  if (legacyRows.length === 0) return selected;

  const own = new Set<string>();
  const others = new Set<string>();
  // Evidence that cannot be read is no evidence, not a failure: the model's
  // own rows cancel without it.
  const methods = new Set(
    legacyRows.map((r) => r.methodName).filter((m) => m !== null),
  );
  for (const method of methods) {
    const ids = new Set(
      legacyRows.filter((r) => r.methodName === method).map((r) => r.id),
    );
    try {
      const records = await evidence.outputs.findByIds(model.type, method, ids);
      for (const [id, record] of records) {
        (record.definitionId === model.definitionId ? own : others).add(id);
      }
    } catch (error) {
      evidence.logger
        .debug`Could not read the ${method} method-run records: ${error}`;
    }
  }

  const unrecorded = legacyRows.filter((r) =>
    !own.has(r.id) && !others.has(r.id)
  );
  if (unrecorded.length > 0) {
    let lock: LockInfo | null = null;
    try {
      lock = await evidence.inspectModelLock();
    } catch (error) {
      evidence.logger.debug`Could not read the model lock: ${error}`;
    }
    if (lock && !lock.holderUnknown) {
      const sameProcess = (
        a: ActiveRun,
        b: { pid: number; hostname: string },
      ) => a.pid === b.pid && a.hostname === b.hostname;
      for (const row of unrecorded) {
        const methodRunsOfProcess = runningRows.filter((r) =>
          r.runKind === "model_method" && sameProcess(r, row)
        );
        if (sameProcess(row, lock) && methodRunsOfProcess.length === 1) {
          own.add(row.id);
        }
      }
    }
  }
  return methodRunsOfModel(runningRows, selector, { own, others });
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

function liveStops(
  stops: readonly OwnerStop[],
): { live: OwnerStop[]; seconds: number } | undefined {
  const live = stops.filter(({ pid }) => isProcessAlive(pid));
  const longest = maxOf(live.map((s) => s.maxWaitMs));
  if (longest === undefined) return undefined;
  return { live, seconds: longest / 1000 };
}

export function cancelAllHint(syntax: CommandSyntax): string {
  return `'${syntax.invocation} --all' stops them, along with every other running method run a swamp serve does not own.`;
}

export const BEHAVIOR_CANCEL_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior cancel",
  surface: "behavior",
};

export const MODEL_CANCEL_SYNTAX: CommandSyntax = {
  invocation: "swamp model cancel",
  surface: "model",
  preferred: `${BEHAVIOR_CANCEL_SYNTAX.invocation} my-server`,
};

export function createModelCancelCommand(syntax: CommandSyntax) {
  const methodNoun = surfaceMethodNoun(syntax.surface);
  const command = withPreferredExample(
    new Command()
      .name("cancel")
      .description(`Cancel a running ${methodNoun} run`)
      .example(
        `Cancel a ${syntax.surface} run`,
        `${syntax.invocation} my-server`,
      )
      .example(
        "Cancel with reason",
        `${syntax.invocation} my-server --reason 'No longer needed'`,
      )
      .example("Cancel all running", `${syntax.invocation} --all`),
    syntax,
  )
    .arguments(
      `[${definitionArgument(syntax.surface)}:${
        definitionNameType(syntax.surface)
      }]`,
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--all",
      `Cancel all running ${
        surfaceMethodNoun(syntax.surface)
      } runs, skipping runs a live swamp serve owns`,
    )
    .option("--reason <reason:string>", "Reason for cancellation")
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    .action(async function (options: AnyOptions, modelIdOrName?: string) {
      const cliCtx = createContext(options as GlobalOptions, [
        "model",
        "cancel",
      ]);

      if (!options.all && !modelIdOrName) {
        throw new UserError(
          `Provide a ${
            surfaceNoun(syntax.surface)
          } name or ID, or use --all to cancel all running runs`,
        );
      }

      const resolution = await resolveDatastoreForRepo(
        resolveRepoDir(options.repoDir),
      );
      const { datastoreConfig } = resolution;
      // On a v3 datastore bound directly, the run's owner holds the writer
      // for the whole run: it is stopped first, through a read-only open.
      const ownerHoldsWriter = resolution.engine === "v3" &&
        resolution.serveUpstream === undefined;
      const openOptions = {
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      };
      const { repoDir, repoContext } = ownerHoldsWriter
        ? await requireInitializedRepoReadOnly(openOptions)
        : await requireInitializedRepoUnlocked(openOptions);

      const reason = options.reason as string | undefined;
      const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
      const cancelRuns = async (
        runs: readonly ActiveRun[],
        onStopping: (stops: readonly OwnerStop[]) => void,
      ): Promise<MethodRunCancelOutcome[]> => {
        if (!ownerHoldsWriter) {
          // a root unit with no push: the run saves stage into it rather than
          // reach the hook through signalChange's fallback
          return await runCommandInRootUnit(
            repoContext,
            { push: undefined },
            () =>
              cancelModelMethodRuns(runs, reason, {
                tracker: runTracker,
                outputRepo: repoContext.outputRepo,
                onStopping,
              }),
          );
        }
        const stopped = await stopMethodRunOwners(runs, {
          tracker: runTracker,
          onStopping,
        });
        const abandoned = abandonedMethodRuns(stopped.stopped, {
          tracker: runTracker,
        });
        if (abandoned.length === 0) {
          return await settleStoppedMethodRuns(stopped, reason, {
            tracker: runTracker,
            outputRepo: repoContext.outputRepo,
          });
        }
        const writer = await openCancelWriter(
          () => requireInitializedRepoUnlocked(openOptions),
          (holder) =>
            new UserError(
              `Stopped the process(es) running these method runs, but could not mark ${abandoned.length} of them cancelled: ${holder} is writing the v3 datastore. ` +
                `See where they ended with '${
                  syntax.surface === "model"
                    ? "swamp model method history search"
                    : "swamp behavior output search"
                }', or cancel again once that process finishes.`,
            ),
        );
        return await runCommandInRootUnit(
          writer.repoContext,
          { push: undefined },
          () =>
            settleStoppedMethodRuns(stopped, reason, {
              tracker: runTracker,
              outputRepo: writer.repoContext.outputRepo,
            }),
        );
      };

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
              cliCtx.logger.info(`No running ${methodNoun} runs to cancel.`);
            } else {
              warnServeOwnedSkipped(cliCtx.logger, serveOwned);
            }
            return;
          }

          const outcomes = await cancelRuns(cancellable, (stops) => {
            const waiting = liveStops(stops);
            if (!waiting || cliCtx.outputMode === "json") return;
            const count = cancellable.filter((r) =>
              waiting.live.some(({ pid }) =>
                pid === r.pid
              )
            ).length;
            cliCtx.logger
              .info`Stopping ${count} method run(s); waiting up to ${waiting.seconds}s for them to stop (cancel again to stop immediately)`;
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
              // Tagged templates, so a count renders as before; the noun is
              // literal text, not an interpolated (quoted) value.
              if (syntax.surface === "model") {
                cliCtx.logger
                  .info`Cancelled ${cancelled.length} running model method run(s)`;
              } else {
                cliCtx.logger
                  .info`Cancelled ${cancelled.length} running method run(s)`;
              }
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

        const definitionRepo = repoContext.definitionRepo;
        const resolved = await definitionRepo.findByNameGlobal(modelIdOrName!);
        if (!resolved) {
          throw new UserError(
            `${
              surfaceNounCapitalized(syntax.surface)
            } '${modelIdOrName}' not found`,
          );
        }

        const { definition, type } = resolved;

        const runningRows = runTracker.findAllRunning();
        const { runs: trackerRuns, unattributed } = await findMethodRunsOfModel(
          runningRows,
          { definitionId: definition.id, type },
          {
            outputs: repoContext.outputRepo,
            inspectModelLock: async () =>
              (await createModelLock(
                datastoreConfig,
                type.normalized,
                definition.id,
              )).inspect(),
            logger: cliCtx.logger,
          },
        );

        if (trackerRuns.length === 0) {
          const noun = surfaceNoun(syntax.surface);
          throw new UserError(
            unattributed.length === 0
              ? `No running method runs found for ${noun} '${definition.name}'`
              : `No running method runs found for ${noun} '${definition.name}'. ` +
                `${unattributed.length} running ${type.normalized} method run(s) were started by an older swamp that did not record which ${noun} they belong to; ` +
                cancelAllHint(syntax),
          );
        }

        const { run: latest, skipped } = selectMethodRunToCancel(
          trackerRuns,
          runningRows,
        );
        if (latest === undefined) {
          const [{ run, instanceId }] = skipped;
          throw new UserError(
            `Method run ${run.id} for ${
              surfaceNoun(syntax.surface)
            } '${definition.name}' belongs to swamp serve instance ${instanceId} and cannot be cancelled locally. ` +
              `To cancel it: ${SERVE_CANCEL_GUIDANCE}.`,
          );
        }

        const [{ status }] = await cancelRuns([latest], (stops) => {
          const waiting = liveStops(stops);
          if (!waiting || cliCtx.outputMode === "json") return;
          cliCtx.logger
            .info`Stopping method run ${latest.id}; waiting up to ${waiting.seconds}s for it to stop (cancel again to stop immediately)`;
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
        } else if (status === "cancelled" && syntax.surface === "model") {
          cliCtx.logger
            .info`Cancelled method run ${
            latest.methodName ?? "unknown"
          } for model ${definition.name} (${latest.id})`;
        } else if (status === "cancelled") {
          cliCtx.logger
            .info`Cancelled method run ${
            latest.methodName ?? "unknown"
          } for behavior ${definition.name} (${latest.id})`;
        } else if (syntax.surface === "model") {
          cliCtx.logger
            .warn`Method run ${
            latest.methodName ?? "unknown"
          } for model ${definition.name} (${latest.id}) finished as ${status} before the cancel took effect`;
        } else {
          cliCtx.logger
            .warn`Method run ${
            latest.methodName ?? "unknown"
          } for behavior ${definition.name} (${latest.id}) finished as ${status} before the cancel took effect`;
        }
        if (cliCtx.outputMode !== "json") {
          warnServeOwnedSkipped(cliCtx.logger, skipped);
        }
      } finally {
        runTracker.close();
      }
    });
  return recordDefiningModule(command, import.meta.url);
}

export const modelCancelCommand = createModelCancelCommand(MODEL_CANCEL_SYNTAX);

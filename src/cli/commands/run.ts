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
import {
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
  serveUpstreamOfRepo,
} from "../repo_context.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
import { UserError } from "../../domain/errors.ts";
import {
  DEFAULT_STALE_TTL_MS,
  localOwnerLiveness,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import {
  findDeadOwnerMethodRuns,
  type MethodRunOutputs,
  type OrphanedMethodRun,
  type OwnerLiveness,
  runHasDeadOwner,
  runRecordFinder,
  type RunRecordStore,
  settleDeadOwnerMethodRuns,
  settleDeadOwnerRun,
  settleInterruptedWorkflowRows,
  settleUnreadableRun,
  trackerShowsDeadOwner,
} from "../../domain/workflows/orphaned_run_reaper.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import { UnreadableRunRecordError } from "../../domain/workflows/unreadable_run_record.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import {
  createModelRunsOutput,
  type DoctorUnreadableRuns,
  writeDoctorRunsJson,
  writeDoctorRunsLog,
  writeModelRunsJson,
  writeModelRunsLog,
} from "../../presentation/output/model_runs_output.ts";
import { groupCommandAction } from "../group_action.ts";
import { runGcCommand } from "./run_gc.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  ServerResponseError,
  withRemoteOptions,
} from "../remote_run.ts";
import type {
  RunDoctorResponse,
  RunHistoryResponse,
} from "../../serve/protocol.ts";
import {
  ActiveRun,
  type ActiveRunStatus,
} from "../../domain/models/active_run.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function responseToActiveRuns(response: RunHistoryResponse): ActiveRun[] {
  return response.runs.map((r) =>
    ActiveRun.fromData({
      id: r.id,
      runKind: r.runKind as "model_method" | "workflow",
      modelType: r.modelType,
      methodName: r.methodName,
      workflowName: r.workflowName,
      pid: r.pid,
      hostname: r.hostname,
      startedAt: r.startedAt,
      heartbeatAt: r.heartbeatAt,
      status: r.status as ActiveRunStatus,
      initiatedBy: r.initiatedBy,
    })
  );
}

const SERVE_RUNS_TIMEOUT_MS = 5_000;

export type ServeRunHistory =
  | { kind: "shown"; runs: ActiveRun[] }
  | { kind: "absent"; reason: string };

/**
 * serve not answering, or refusing the caller, leaves its runs out with the
 * reason; the checkout's own runs are still listed
 */
export async function serveRunHistoryOf(
  request: () => Promise<RunHistoryResponse>,
): Promise<ServeRunHistory> {
  try {
    return { kind: "shown", runs: responseToActiveRuns(await request()) };
  } catch (error) {
    if (error instanceof ServerResponseError && error.code === "unauthorized") {
      return { kind: "absent", reason: "needs admin on serve" };
    }
    if (error instanceof ServerResponseError) {
      return { kind: "absent", reason: `serve refused (${error.code})` };
    }
    return { kind: "absent", reason: "serve is unreachable" };
  }
}

/** one row per run id, the checkout's own row winning, newest first */
export function mergeRunHistory(
  local: readonly ActiveRun[],
  serve: readonly ActiveRun[],
): ActiveRun[] {
  const ids = new Set(local.map((run) => run.id));
  return [...local, ...serve.filter((run) => !ids.has(run.id))].sort((a, b) =>
    b.startedAt.getTime() - a.startedAt.getTime()
  );
}

const runHistoryCommand = withRemoteOptions(
  new Command()
    .name("history")
    .description("List active and recent runs (methods and workflows)")
    .example("List recent runs (last 24h)", "swamp run history")
    .example("List only active runs", "swamp run history --active")
    .example("List all tracked runs", "swamp run history --all")
    .example(
      "List runs on a server",
      "swamp run history --server http://127.0.0.1:7766",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--active",
      "Show only currently running (mutually exclusive with --all)",
    )
    .option(
      "--all",
      "Show all tracked runs, not just recent (mutually exclusive with --active)",
    )
    .action(async function (options: AnyOptions) {
      if (options.active && options.all) {
        throw new UserError("--active and --all are mutually exclusive");
      }
      const ctx = createContext(options as GlobalOptions, ["run", "history"]);

      const server = resolveServeUrl(options.server as string | undefined);
      if (server) {
        const token = await resolveServerTokenFromOptions(
          server,
          options,
        );
        const response = await requestServerResponse<RunHistoryResponse>(
          { server, token },
          {
            type: "run.history",
            payload: {
              active: !!options.active,
              all: !!options.all,
            },
          },
        );
        const runs = responseToActiveRuns(response);
        if (ctx.outputMode === "json") {
          writeModelRunsJson(runs);
        } else {
          writeModelRunsLog(runs);
        }
        return;
      }

      // it only reads: it never takes the v3 writer lease, which would start a
      // replication lineage on a bucket.
      const { repoDir } = await requireInitializedRepoReadOnly({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: ctx.outputMode,
      });

      const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
      const output = createModelRunsOutput(ctx.outputMode);

      let runs: ActiveRun[];
      try {
        runs = options.active
          ? tracker.findAllRunning()
          : options.all
          ? tracker.findAll()
          : tracker.findRecent();
      } finally {
        tracker.close();
      }
      // a team member's checkout runs this here; serve's runs are added when
      // serve answers
      const serveUpstream = await serveUpstreamOfRepo(repoDir);
      if (serveUpstream !== undefined) {
        const server = serveUpstream.serverUrl;
        const served = await serveRunHistoryOf(async () =>
          await requestServerResponse<RunHistoryResponse>(
            {
              server,
              token: await resolveServerTokenFromOptions(server, options),
              timeoutMs: SERVE_RUNS_TIMEOUT_MS,
            },
            {
              type: "run.history",
              payload: { active: !!options.active, all: !!options.all },
            },
          )
        );
        if (served.kind === "shown") {
          runs = mergeRunHistory(runs, served.runs);
        } else {
          ctx.logger.warn`Listing only this checkout's runs: ${served.reason}`;
        }
      }
      output.writeRuns(runs);
    }),
);

const ORPHAN_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface LocalRunDiagnosis {
  readonly totalTracked: number;
  readonly active: ActiveRun[];
  readonly stale: ActiveRun[];
  readonly reaped: number;
  readonly orphanedWorkflowRuns: number;
  readonly orphanedReaped: number;
  readonly orphanedMethodRuns: number;
  readonly orphanedMethodReaped: number;
  readonly orphanedMethodError?: string;
  readonly unreadable: DoctorUnreadableRuns;
}

/**
 * a tracker row is stale when its heartbeat expired or its owner is a dead
 * process on this host. Recent records are found by scanning, older ones through
 * their workflow tracker row, so no run is stranded by its age or a rename.
 */
export async function diagnoseLocalRuns(
  tracker: RunTrackerStore,
  runRepo: WorkflowRunRepository & Pick<RunRecordStore, "listWorkflowIds">,
  workflowRepo: Pick<WorkflowRepository, "findByName">,
  outputRepo: MethodRunOutputs,
  liveness: OwnerLiveness,
  fix: boolean,
): Promise<LocalRunDiagnosis> {
  const allRuns = tracker.findAll();
  const staleById = new Map(
    tracker.findStaleRuns(DEFAULT_STALE_TTL_MS).map((r) => [r.id, r]),
  );
  for (const run of tracker.findDeadProcessRuns(liveness.instanceId)) {
    staleById.set(run.id, run);
  }
  const stale = [...staleById.values()];
  const active = allRuns.filter((r) =>
    r.status === "running" && !staleById.has(r.id)
  );

  let reaped = 0;
  if (fix && stale.length > 0) {
    const reapedIds = new Set([
      ...tracker.reapStaleRuns(DEFAULT_STALE_TTL_MS, liveness.instanceId),
      ...tracker.reapDeadProcessRuns(liveness.instanceId),
    ].map((r) => r.id));
    reaped = reapedIds.size;
  }

  // Method runs first, so the step method runs a settled workflow run takes
  // with it are counted here too. A failure is reported, not thrown, so the
  // workflow runs are still diagnosed.
  let orphanedMethods: OrphanedMethodRun[] = [];
  let orphanedMethodError: string | undefined;
  try {
    orphanedMethods = fix
      ? await settleDeadOwnerMethodRuns(outputRepo, tracker, liveness)
      : (await findDeadOwnerMethodRuns(outputRepo, tracker, liveness)).running;
  } catch (error) {
    orphanedMethodError = error instanceof Error
      ? error.message
      : String(error);
  }

  let orphanedWorkflowRuns = 0;
  let orphanedReaped = 0;
  // from the records, not the index as it stands: a stale entry would hide the
  // very run being looked for.
  await runRepo.verifyIndexes?.();
  const records = new Map(
    (await runRepo.findGlobalByStatus(
      "running",
      new Date(Date.now() - ORPHAN_SCAN_WINDOW_MS),
    )).map((record) => [record.run.id as string, record]),
  );
  const findRecord = runRecordFinder(runRepo, workflowRepo);
  if (fix) await settleInterruptedWorkflowRows(tracker, findRecord);
  for (const row of tracker.findAll()) {
    if (row.runKind !== "workflow" || row.settled || records.has(row.id)) {
      continue;
    }
    if (!trackerShowsDeadOwner(row, liveness)) continue;
    let record;
    try {
      record = await findRecord(row);
    } catch (error) {
      // Reported and settled through findUnreadableRuns below.
      if (error instanceof UnreadableRunRecordError) continue;
      throw error;
    }
    if (record?.run.status === "running") records.set(row.id, record);
  }
  for (const { run, workflowId } of records.values()) {
    if (!runHasDeadOwner(run, tracker, liveness)) continue;
    orphanedWorkflowRuns++;
    if (
      fix &&
      await settleDeadOwnerRun(
        runRepo,
        tracker,
        workflowId,
        run.id,
        liveness,
        outputRepo,
      )
    ) {
      orphanedReaped++;
    }
  }

  const unreadableRuns = await runRepo.findUnreadableRuns?.() ?? [];
  let unreadableReaped = 0;
  if (fix) {
    for (const unreadable of unreadableRuns) {
      if (await settleUnreadableRun(runRepo, tracker, unreadable, liveness)) {
        unreadableReaped++;
      }
    }
  }

  return {
    totalTracked: allRuns.length,
    unreadable: {
      runs: unreadableRuns.map(({ runId, path, reason }) => ({
        runId,
        path,
        reason,
      })),
      reaped: unreadableReaped,
    },
    active,
    stale,
    reaped,
    orphanedWorkflowRuns,
    orphanedReaped,
    orphanedMethodRuns: orphanedMethods.length,
    orphanedMethodReaped: fix ? orphanedMethods.length : 0,
    ...(orphanedMethodError !== undefined ? { orphanedMethodError } : {}),
  };
}

const runDoctorCommand = withRemoteOptions(
  new Command()
    .name("doctor")
    .description("Diagnose stale, orphaned or unreadable runs")
    .example("Check for stale runs", "swamp run doctor")
    .example("Auto-reap stale runs", "swamp run doctor --fix")
    .example(
      "Check on a server",
      "swamp run doctor --server http://127.0.0.1:7766",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--fix",
      "Reap stale runs and settle unreadable runs whose owner is gone, replacing the record",
    )
    .action(async function (options: AnyOptions) {
      const ctx = createContext(options as GlobalOptions, ["run", "doctor"]);

      const server = resolveServeUrl(options.server as string | undefined);
      if (server) {
        const token = await resolveServerTokenFromOptions(
          server,
          options,
        );
        const response = await requestServerResponse<RunDoctorResponse>(
          { server, token },
          {
            type: "run.doctor",
            payload: { fix: !!options.fix },
          },
        );
        const activeRuns = responseToActiveRuns({
          runs: response.activeRuns ?? [],
        });
        const staleRuns = responseToActiveRuns({
          runs: response.staleRuns ?? [],
        });
        const progressByRun = new Map(
          [...(response.activeRuns ?? []), ...(response.staleRuns ?? [])]
            .filter((run) => run.progress !== undefined)
            .map((run) => [run.id, {
              progress: run.progress,
              progressScope: run.progressScope,
            }]),
        );
        if (response.liveProgress) {
          for (
            const [runId, progress] of Map.groupBy(
              response.liveProgress,
              (p) => p.runId,
            )
          ) {
            progressByRun.set(runId, {
              progress,
              progressScope: "process_local",
            });
          }
        }
        if (ctx.outputMode === "json") {
          writeDoctorRunsJson(
            response.totalTracked,
            activeRuns,
            staleRuns,
            response.reaped,
            response.orphanedWorkflowRuns,
            response.orphanedReaped,
            undefined,
            undefined,
            undefined,
            progressByRun,
            response.webhookAdmissions,
            {
              runs: response.unreadableRuns ?? [],
              reaped: response.unreadableReaped ?? 0,
            },
          );
        } else {
          writeDoctorRunsLog(
            activeRuns,
            staleRuns,
            response.reaped,
            !!options.fix,
            response.orphanedWorkflowRuns,
            response.orphanedReaped,
            undefined,
            undefined,
            undefined,
            progressByRun,
            response.webhookAdmissions,
            {
              runs: response.unreadableRuns ?? [],
              reaped: response.unreadableReaped ?? 0,
            },
          );
        }
        return;
      }

      const { repoDir, repoContext } = await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: ctx.outputMode,
      });

      const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));

      try {
        // in a root unit of work with no push, so the fix's saves stage into it
        // instead of reaching the hook through signalChange's fallback. Nothing
        // pushes.
        const result = await runCommandInRootUnit(
          repoContext,
          { push: undefined },
          () =>
            diagnoseLocalRuns(
              tracker,
              repoContext.workflowRunRepo,
              repoContext.workflowRepo,
              repoContext.outputRepo,
              localOwnerLiveness(),
              !!options.fix,
            ),
        );

        if (ctx.outputMode === "json") {
          writeDoctorRunsJson(
            result.totalTracked,
            result.active,
            result.stale,
            result.reaped,
            result.orphanedWorkflowRuns,
            result.orphanedReaped,
            result.orphanedMethodRuns,
            result.orphanedMethodReaped,
            result.orphanedMethodError,
            undefined,
            undefined,
            result.unreadable,
          );
        } else {
          writeDoctorRunsLog(
            result.active,
            result.stale,
            result.reaped,
            !!options.fix,
            result.orphanedWorkflowRuns,
            result.orphanedReaped,
            result.orphanedMethodRuns,
            result.orphanedMethodReaped,
            result.orphanedMethodError,
            undefined,
            undefined,
            result.unreadable,
          );
        }
      } finally {
        tracker.close();
      }
    }),
);

export const runCommand = new Command()
  .name("run")
  .description("Track and diagnose in-flight method and workflow runs")
  .action(groupCommandAction)
  .command("history", runHistoryCommand)
  .command("doctor", runDoctorCommand)
  .command("gc", runGcCommand);

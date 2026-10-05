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
  settleDeadOwnerMethodRuns,
  settleDeadOwnerRun,
  trackerShowsDeadOwner,
} from "../../domain/workflows/orphaned_run_reaper.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import {
  createWorkflowRunId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import {
  createModelRunsOutput,
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

const runHistoryCommand = withRemoteOptions(
  new Command()
    .name("history")
    .description("List active and recent runs (model methods and workflows)")
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

      const { repoDir } = await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: ctx.outputMode,
      });

      const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
      const output = createModelRunsOutput(ctx.outputMode);

      try {
        const runs = options.active
          ? tracker.findAllRunning()
          : options.all
          ? tracker.findAll()
          : tracker.findRecent();

        output.writeRuns(runs);
      } finally {
        tracker.close();
      }
    }),
);

/** How far back `run doctor` looks for workflow runs left `running`. */
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
  /** Why method runs could not be checked or settled, if they could not. */
  readonly orphanedMethodError?: string;
}

/**
 * Local `swamp run doctor`. A tracker row is stale when its heartbeat
 * expired or its owner is a dead process on this host. Workflow and method
 * run records still `running` whose tracker row shows a dead owner are
 * orphaned; with `fix`, the stale rows are reaped, the orphaned workflow
 * records interrupted so `swamp workflow recover` accepts them, and the
 * orphaned method runs cancelled.
 *
 * Recent records are found by scanning; an older one is found through its
 * workflow tracker row, so no run is stranded by its age. With `fix`, an
 * `interrupted` workflow row whose record is already settled is marked so,
 * and retention may then purge it.
 */
export async function diagnoseLocalRuns(
  tracker: RunTrackerStore,
  runRepo: WorkflowRunRepository,
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
  // From the records, not the index as it stands: a stale entry would hide
  // the very run being looked for (swamp-club#2518).
  await runRepo.rebuildIndexes?.();
  const records = new Map(
    (await runRepo.findGlobalByStatus(
      "running",
      new Date(Date.now() - ORPHAN_SCAN_WINDOW_MS),
    )).map((record) => [record.run.id as string, record]),
  );
  for (const row of tracker.findAll()) {
    if (row.runKind !== "workflow" || records.has(row.id)) continue;
    const unsettled = fix && row.status === "interrupted";
    if (!unsettled && !trackerShowsDeadOwner(row, liveness)) continue;
    const record = await findRunRecord(runRepo, workflowRepo, row);
    if (!record) continue;
    if (record.run.status === "running") {
      records.set(row.id, record);
    } else if (unsettled) {
      tracker.markSettled(row.id, "record_settled");
    }
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

  return {
    totalTracked: allRuns.length,
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

/** The run record behind a workflow tracker row, found by workflow name. */
async function findRunRecord(
  runRepo: WorkflowRunRepository,
  workflowRepo: Pick<WorkflowRepository, "findByName">,
  row: ActiveRun,
): Promise<{ run: WorkflowRun; workflowId: WorkflowId } | null> {
  if (!row.workflowName) return null;
  const workflow = await workflowRepo.findByName(row.workflowName);
  if (!workflow) return null;
  const run = await runRepo.findById(workflow.id, createWorkflowRunId(row.id));
  return run ? { run, workflowId: workflow.id } : null;
}

const runDoctorCommand = withRemoteOptions(
  new Command()
    .name("doctor")
    .description("Diagnose stale or orphaned runs")
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
    .option("--fix", "Automatically reap stale runs")
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
        if (ctx.outputMode === "json") {
          writeDoctorRunsJson(
            response.totalTracked,
            activeRuns,
            staleRuns,
            response.reaped,
            response.orphanedWorkflowRuns,
            response.orphanedReaped,
          );
        } else {
          writeDoctorRunsLog(
            activeRuns,
            staleRuns,
            response.reaped,
            !!options.fix,
            response.orphanedWorkflowRuns,
            response.orphanedReaped,
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
        const result = await diagnoseLocalRuns(
          tracker,
          repoContext.workflowRunRepo,
          repoContext.workflowRepo,
          repoContext.outputRepo,
          localOwnerLiveness(),
          !!options.fix,
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
          );
        }
      } finally {
        tracker.close();
      }
    }),
);

export const runCommand = new Command()
  .name("run")
  .description("Track and diagnose in-flight model method and workflow runs")
  .action(groupCommandAction)
  .command("history", runHistoryCommand)
  .command("doctor", runDoctorCommand)
  .command("gc", runGcCommand);

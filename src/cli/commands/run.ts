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
import {
  DEFAULT_STALE_TTL_MS,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import {
  createModelRunsOutput,
  writeDoctorRunsJson,
  writeDoctorRunsLog,
  writeModelRunsJson,
  writeModelRunsLog,
} from "../../presentation/output/model_runs_output.ts";
import { groupCommandAction } from "../group_action.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type {
  RunDoctorResponse,
  RunHistoryResponse,
} from "../../serve/protocol.ts";
import { ActiveRun } from "../../domain/models/active_run.ts";

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
      status: r.status as "running" | "completed" | "failed" | "cancelled",
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
    .option("--active", "Show only currently running")
    .option("--all", "Show all tracked runs (not just recent)")
    .action(async function (options: AnyOptions) {
      const ctx = createContext(options as GlobalOptions, ["run", "history"]);

      const server = resolveServeUrl(options.server as string | undefined);
      if (server) {
        const token = await resolveServerToken(
          server,
          options.token as string | undefined,
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
        const token = await resolveServerToken(
          server,
          options.token as string | undefined,
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
          );
        } else {
          writeDoctorRunsLog(
            activeRuns,
            staleRuns,
            response.reaped,
            !!options.fix,
          );
        }
        return;
      }

      const { repoDir } = await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: ctx.outputMode,
      });

      const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));

      try {
        const allRuns = tracker.findAll();
        const running = allRuns.filter((r) => r.status === "running");
        const stale = tracker.findStaleRuns(DEFAULT_STALE_TTL_MS);
        const active = running.filter((r) => !r.isStale(DEFAULT_STALE_TTL_MS));

        let reaped = 0;
        if (options.fix && stale.length > 0) {
          const reapedRuns = tracker.reapStaleRuns(DEFAULT_STALE_TTL_MS);
          reaped = reapedRuns.length;
        }

        if (ctx.outputMode === "json") {
          writeDoctorRunsJson(
            allRuns.length,
            active,
            stale,
            reaped,
          );
        } else {
          writeDoctorRunsLog(active, stale, reaped, !!options.fix);
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
  .command("doctor", runDoctorCommand);

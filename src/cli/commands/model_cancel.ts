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
import { killProcessTree } from "../../infrastructure/process/process_kill.ts";
import {
  DEFAULT_STALE_TTL_MS,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

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
    runTracker.reapStaleRuns(DEFAULT_STALE_TTL_MS);

    if (options.all) {
      const trackerRuns = runTracker.findAllRunning();

      if (trackerRuns.length === 0) {
        if (cliCtx.outputMode === "json") {
          console.log(JSON.stringify({ cancelled: [] }));
        } else {
          cliCtx.logger.info("No running model method runs to cancel.");
        }
        runTracker.close();
        return;
      }

      const cancelled: { id: string; type: string; method: string }[] = [];
      for (const run of trackerRuns) {
        if (run.pid !== Deno.pid) {
          await killProcessTree(run.pid);
        }
        runTracker.complete(run.id, "cancelled");
        cancelled.push({
          id: run.id,
          type: run.modelType ?? "unknown",
          method: run.methodName ?? "unknown",
        });
      }

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
      runTracker.close();
      return;
    }

    // Cancel a specific model's running output
    const definitionRepo = repoContext.definitionRepo;
    const resolved = await definitionRepo.findByNameGlobal(modelIdOrName!);
    if (!resolved) {
      runTracker.close();
      throw new UserError(
        `Model '${modelIdOrName}' not found`,
      );
    }

    const { definition, type } = resolved;

    const trackerRuns = runTracker.findAllRunning().filter(
      (r) => r.modelType === type.normalized,
    );

    if (trackerRuns.length === 0) {
      runTracker.close();
      throw new UserError(
        `No running method runs found for model '${definition.name}'`,
      );
    }

    const latest = trackerRuns.sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
    )[0];

    if (latest.pid !== Deno.pid) {
      await killProcessTree(latest.pid);
    }
    runTracker.complete(latest.id, "cancelled");

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
    runTracker.close();
  });

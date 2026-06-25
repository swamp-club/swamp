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

    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const outputRepo = repoContext.outputRepo;
    const reason = options.reason as string | undefined;

    if (options.all) {
      const allOutputs = await outputRepo.findAllGlobal();
      const running = allOutputs.filter((o) => o.output.status === "running");

      if (running.length === 0) {
        if (cliCtx.outputMode === "json") {
          console.log(JSON.stringify({ cancelled: [] }));
        } else {
          cliCtx.logger.info("No running model method runs to cancel.");
        }
        return;
      }

      const cancelled: { id: string; type: string; method: string }[] = [];
      for (const entry of running) {
        if (entry.output.pid && entry.output.pid !== Deno.pid) {
          await killProcessTree(entry.output.pid);
        }
        entry.output.markCancelled(reason);
        await outputRepo.save(entry.type, entry.method, entry.output);
        cancelled.push({
          id: entry.output.id,
          type: entry.type.normalized,
          method: entry.method,
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

    const allOutputs = await outputRepo.findAll(type);
    const running = allOutputs.filter(
      (o) => o.definitionId === definition.id && o.status === "running",
    );

    if (running.length === 0) {
      throw new UserError(
        `No running method runs found for model '${definition.name}'`,
      );
    }

    const latest = running.sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
    )[0];

    if (latest.pid && latest.pid !== Deno.pid) {
      await killProcessTree(latest.pid);
    }
    latest.markCancelled(reason);
    await outputRepo.save(type, latest.methodName, latest);

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify({
        id: latest.id,
        modelName: definition.name,
        type: type.normalized,
        method: latest.methodName,
        status: "cancelled",
        reason: reason ?? null,
      }));
    } else {
      cliCtx.logger
        .info`Cancelled method run ${latest.methodName} for model ${definition.name} (${latest.id})`;
    }
  });

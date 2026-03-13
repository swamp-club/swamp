// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { WorkflowExecutionService } from "../../domain/workflows/execution_service.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { parseInputs } from "../input_parser.ts";
import { parseTags } from "./data_search.ts";
import { workflowRunSearchCommand } from "./workflow_run_search.ts";
import {
  consumeStream,
  createLibSwampContext,
  workflowRun,
  type WorkflowRunDeps,
} from "../../libswamp/mod.ts";
import { createWorkflowRunRenderer } from "../../presentation/renderers/workflow_run.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowRunCommand = new Command()
  .name("run")
  .description("Execute a workflow")
  .arguments("<workflow_id_or_name:workflow_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--last-evaluated",
    "Skip CEL evaluation, use previously evaluated workflow and definitions",
    { default: false },
  )
  .option("--input <value:string>", "Input values (key=value or JSON)", {
    collect: true,
  })
  .option("--input-file <file:string>", "Input values from YAML file")
  .option(
    "--tag <tag:string>",
    "Add tag to produced data (KEY=VALUE, repeatable)",
    { collect: true },
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "run"]);
    ctx.logger.debug`Running workflow: ${workflowIdOrName}`;

    const { repoDir, repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const workflowRepo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;

    const lastEvaluated = options.lastEvaluated as boolean;

    // Parse input values
    const { inputs } = await parseInputs({
      input: options.input as string[] | undefined,
      inputFile: options.inputFile as string | undefined,
    });

    // Parse runtime tags
    const runtimeTags = options.tag
      ? parseTags(options.tag as string[])
      : undefined;

    try {
      const deps: WorkflowRunDeps = {
        workflowRepo,
        runRepo,
        repoDir,
        lookupWorkflow: async (repo, idOrName) => {
          return await repo.findByName(idOrName) ??
            await repo.findById(createWorkflowId(idOrName));
        },
        createExecutionService: (wfRepo, rnRepo, dir) =>
          new WorkflowExecutionService(wfRepo, rnRepo, dir),
      };

      const libCtx = createLibSwampContext();
      const renderer = createWorkflowRunRenderer(ctx.outputMode, {
        workflowName: workflowIdOrName,
      });

      await consumeStream(
        workflowRun(libCtx, deps, {
          workflowIdOrName,
          lastEvaluated,
          inputs,
          runtimeTags,
          enableStepLogging: ctx.outputMode !== "json",
          verbose: ctx.verbosity === "verbose",
        }),
        renderer.handlers(),
      );

      if (renderer.workflowFailed()) {
        Deno.exit(1);
      }
    } catch (error) {
      if (error instanceof UserError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`Workflow execution failed: ${message}`);
    }
  })
  .command("search", workflowRunSearchCommand);

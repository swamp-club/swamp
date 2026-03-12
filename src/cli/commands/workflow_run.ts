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
import {
  acquireModelLocks,
  requireInitializedRepo,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { extractModelReferencesFromWorkflow } from "../../domain/workflows/model_reference_extractor.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
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
  .option(
    "--driver <driver:string>",
    "Override execution driver (e.g. raw, docker)",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "run"]);
    ctx.logger.debug`Running workflow: ${workflowIdOrName}`;

    // First try unlocked to resolve workflow and model references
    const unlocked = await requireInitializedRepoUnlocked({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const workflowRepo = unlocked.repoContext.workflowRepo;

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

    let flushModelLocks: (() => Promise<void>) | null = null;
    let repoDir: string;
    let repoContext: typeof unlocked.repoContext;

    try {
      // Pre-lookup workflow for per-model lock acquisition
      const preWorkflow = await workflowRepo.findByName(workflowIdOrName) ??
        await workflowRepo.findById(createWorkflowId(workflowIdOrName));

      if (preWorkflow) {
        // Try to extract model references for per-model locking
        const modelRefs = await extractModelReferencesFromWorkflow(
          preWorkflow,
          workflowRepo,
        );

        if (modelRefs !== null && modelRefs.length > 0) {
          const definitionRepo = unlocked.repoContext.definitionRepo;
          const resolvedModels: Array<
            { modelType: string; modelId: string }
          > = [];

          for (const ref of modelRefs) {
            const lookupResult = await findDefinitionByIdOrName(
              definitionRepo,
              ref,
            );
            if (lookupResult) {
              resolvedModels.push({
                modelType: lookupResult.type.normalized,
                modelId: lookupResult.definition.id,
              });
            }
          }

          if (resolvedModels.length > 0) {
            flushModelLocks = await acquireModelLocks(
              unlocked.datastoreConfig,
              resolvedModels,
            );
          }

          repoDir = unlocked.repoDir;
          repoContext = unlocked.repoContext;
        } else if (modelRefs === null) {
          // Dynamic references — fall back to global lock
          const logger = getSwampLogger(["workflow", "run"]);
          logger
            .info`Workflow contains dynamic model references — using global lock`;
          const globalResult = await requireInitializedRepo({
            repoDir: options.repoDir ?? ".",
            outputMode: ctx.outputMode,
          });
          repoDir = globalResult.repoDir;
          repoContext = globalResult.repoContext;
        } else {
          repoDir = unlocked.repoDir;
          repoContext = unlocked.repoContext;
        }
      } else {
        repoDir = unlocked.repoDir;
        repoContext = unlocked.repoContext;
      }

      const runRepo = repoContext.workflowRunRepo;

      const deps: WorkflowRunDeps = {
        workflowRepo: repoContext.workflowRepo,
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
          verbose: ctx.verbosity === "verbose",
          driver: options.driver as string | undefined,
        }),
        renderer.handlers(),
      );

      // Release per-model locks on success
      if (flushModelLocks) await flushModelLocks();

      if (renderer.workflowFailed()) {
        Deno.exit(1);
      }
    } catch (error) {
      // Release per-model locks on error (best-effort — don't lose original error)
      try {
        if (flushModelLocks) await flushModelLocks();
      } catch (releaseError) {
        const logger = getSwampLogger(["workflow", "run"]);
        logger.warn("Failed to release locks during error cleanup: {error}", {
          error: releaseError instanceof Error
            ? releaseError.message
            : String(releaseError),
        });
      }

      if (error instanceof UserError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`Workflow execution failed: ${message}`);
    }
  })
  .command("search", workflowRunSearchCommand);

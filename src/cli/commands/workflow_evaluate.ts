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
import {
  consumeStream,
  createLibSwampContext,
  createWorkflowEvaluateDeps,
  workflowEvaluate,
} from "../../libswamp/mod.ts";
import { createWorkflowEvaluateRenderer } from "../../presentation/renderers/workflow_evaluate.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { extractModelReferencesFromWorkflow } from "../../domain/workflows/model_reference_extractor.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { parseInputs } from "../input_parser.ts";
import { InputValidationService } from "../../domain/inputs/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowEvaluateCommand = new Command()
  .name("evaluate")
  .description("Evaluate expressions in workflow definitions")
  .example("Evaluate a workflow", "swamp workflow evaluate deploy-pipeline")
  .example("Evaluate all workflows", "swamp workflow evaluate --all")
  .example(
    "With inputs",
    "swamp workflow evaluate deploy-pipeline --input env=prod",
  )
  .arguments("[workflow_id_or_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--all", "Evaluate all workflow definitions")
  .option("--input <value:string>", "Input values (key=value or JSON)", {
    collect: true,
  })
  .option("--input-file <file:string>", "Input values from YAML file")
  .action(
    async function (options: AnyOptions, workflowIdOrName?: string) {
      const cliCtx = createContext(options as GlobalOptions, [
        "workflow",
        "evaluate",
      ]);

      // Parse input values
      const { inputs } = await parseInputs({
        input: options.input as string[] | undefined,
        inputFile: options.inputFile as string | undefined,
      });

      // If --all flag or no argument, evaluate all workflows (global lock)
      if (options.all || !workflowIdOrName) {
        const { repoDir, datastoreResolver } = await requireInitializedRepo({
          repoDir: options.repoDir ?? ".",
          outputMode: cliCtx.outputMode,
        });

        const ctx = createLibSwampContext({ logger: cliCtx.logger });
        const deps = createWorkflowEvaluateDeps(repoDir, datastoreResolver);
        const renderer = createWorkflowEvaluateRenderer(cliCtx.outputMode);

        await consumeStream(
          workflowEvaluate(ctx, deps, { inputs }),
          renderer.handlers(),
        );
        return;
      }

      // Single workflow evaluation — use per-model lock
      const unlocked = await requireInitializedRepoUnlocked({
        repoDir: options.repoDir ?? ".",
        outputMode: cliCtx.outputMode,
      });
      const workflowRepo = unlocked.repoContext.workflowRepo;

      // Look up the workflow for input validation and lock resolution
      const workflow = await workflowRepo.findByName(workflowIdOrName) ??
        await workflowRepo.findById(createWorkflowId(workflowIdOrName));

      if (!workflow) {
        throw new UserError(`Workflow not found: ${workflowIdOrName}`);
      }

      // Validate inputs against workflow schema if provided
      if (workflow.inputs && Object.keys(inputs).length > 0) {
        const validationService = new InputValidationService();
        const inputsWithDefaults = validationService.applyDefaults(
          inputs,
          workflow.inputs,
        );
        const validationResult = validationService.validate(
          inputsWithDefaults,
          workflow.inputs,
        );
        if (!validationResult.valid) {
          const errorMessages = validationResult.errors
            .map((e) => `  ${e.message}`)
            .join("\n");
          throw new UserError(`Input validation failed:\n${errorMessages}`);
        }
        // Use inputs with defaults applied
        Object.assign(inputs, inputsWithDefaults);
      }

      // Extract model references for per-model locking
      const modelRefs = await extractModelReferencesFromWorkflow(
        workflow,
        workflowRepo,
      );

      let flushModelLocks: (() => Promise<void>) | null = null;
      let repoDir: string;
      let datastoreResolver = unlocked.datastoreResolver;

      if (modelRefs !== null && modelRefs.length > 0) {
        // Resolve model references to { modelType, modelId }
        const definitionRepo = unlocked.repoContext.definitionRepo;
        const resolvedModels: Array<{ modelType: string; modelId: string }> =
          [];

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
          const lockResult = await acquireModelLocks(
            unlocked.datastoreConfig,
            resolvedModels,
            unlocked.repoDir,
          );
          if (lockResult.synced) {
            unlocked.repoContext.catalogStore?.invalidate();
          }
          flushModelLocks = lockResult.flush;
        }

        repoDir = unlocked.repoDir;
      } else if (modelRefs === null) {
        // Dynamic references — fall back to global lock
        const logger = getSwampLogger(["workflow", "evaluate"]);
        logger
          .info`Workflow contains dynamic model references — using global lock`;
        const globalResult = await requireInitializedRepo({
          repoDir: options.repoDir ?? ".",
          outputMode: cliCtx.outputMode,
        });
        repoDir = globalResult.repoDir;
        datastoreResolver = globalResult.datastoreResolver;
      } else {
        // No model references
        repoDir = unlocked.repoDir;
      }

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = createWorkflowEvaluateDeps(repoDir, datastoreResolver);
      const renderer = createWorkflowEvaluateRenderer(cliCtx.outputMode);

      try {
        await consumeStream(
          workflowEvaluate(ctx, deps, { workflowIdOrName, inputs }),
          renderer.handlers(),
        );
      } finally {
        if (flushModelLocks) await flushModelLocks();
      }
    },
  );

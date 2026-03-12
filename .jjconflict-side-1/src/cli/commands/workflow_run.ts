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
import {
  renderWorkflowRun,
} from "../../presentation/output/workflow_run_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { WorkflowExecutionService } from "../../domain/workflows/execution_service.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { coerceInputTypes, parseInputs } from "../input_parser.ts";
import { parseTags } from "./data_search.ts";
import { InputValidationService } from "../../domain/inputs/mod.ts";
import { workflowRunSearchCommand } from "./workflow_run_search.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import {
  workflowRun,
  type WorkflowRunDeps,
  type WorkflowRunEvent,
} from "../../libswamp/workflows/run.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { getWorkflowRunLogger } from "../../infrastructure/logging/logger.ts";

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
      // Look up workflow first to get its data for input validation
      const workflow = await workflowRepo.findByName(workflowIdOrName) ??
        await workflowRepo.findById(createWorkflowId(workflowIdOrName));

      if (!workflow) {
        throw new UserError(`Workflow not found: ${workflowIdOrName}`);
      }

      // Coerce k=v string inputs to match schema types before validation
      const coercedInputs = workflow.inputs
        ? coerceInputTypes(inputs, workflow.inputs)
        : inputs;
      Object.assign(inputs, coercedInputs);

      // Validate inputs against workflow schema if provided
      // Skip validation when using --last-evaluated since inputs are already baked in
      if (workflow.inputs && !lastEvaluated) {
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
      const isLogMode = ctx.outputMode !== "json";
      let workflowName = workflowIdOrName;
      let failed = false;

      await consumeStream<WorkflowRunEvent>(
        workflowRun(libCtx, deps, {
          workflowIdOrName,
          lastEvaluated,
          inputs,
          runtimeTags,
          enableStepLogging: isLogMode,
          verbose: ctx.verbosity === "verbose",
        }),
        withDefaults<WorkflowRunEvent>({
          started: (e) => {
            workflowName = e.workflowName;
            if (isLogMode) {
              getWorkflowRunLogger(e.workflowName).info("Starting workflow");
            } else {
              ctx.logger.debug`Workflow started: ${e.workflowName}`;
            }
          },
          job_started: (e) => {
            if (isLogMode) {
              getWorkflowRunLogger(workflowName, e.jobId).info("Job started");
            } else {
              ctx.logger.debug`Job started: ${e.jobId}`;
            }
          },
          job_completed: (e) => {
            if (isLogMode) {
              getWorkflowRunLogger(workflowName, e.jobId).info("Job completed");
            }
          },
          job_skipped: (e) => {
            if (isLogMode) {
              getWorkflowRunLogger(workflowName, e.jobId).info("Job skipped");
            }
          },
          step_started: (e) => {
            if (isLogMode) {
              getWorkflowRunLogger(workflowName, e.jobId, e.stepId).info(
                "Step started",
              );
            } else {
              ctx.logger.debug`Step started: ${e.jobId}/${e.stepId}`;
            }
          },
          step_completed: (e) => {
            if (isLogMode) {
              getWorkflowRunLogger(workflowName, e.jobId, e.stepId).info(
                "Step completed",
              );
            }
          },
          step_skipped: (e) => {
            if (isLogMode) {
              getWorkflowRunLogger(workflowName, e.jobId, e.stepId).info(
                "Step skipped",
              );
            }
          },
          step_failed: (e) => {
            if (isLogMode) {
              getWorkflowRunLogger(workflowName, e.jobId, e.stepId).error(
                "Step failed: {error}",
                { error: e.error },
              );
            } else {
              ctx.logger.debug`Step failed: ${e.jobId}/${e.stepId}: ${e.error}`;
            }
          },
          completed: (e) => {
            if (isLogMode) {
              const wfLogger = getWorkflowRunLogger(workflowName);
              if (e.run.status === "failed") {
                wfLogger.error("Workflow {status}", { status: e.run.status });
              } else {
                wfLogger.with({ summary: true }).info("Workflow {status}", {
                  status: e.run.status,
                });

                // Collect unique data artifact names across all steps
                const artifactNames = new Set<string>();
                for (const job of e.run.jobs) {
                  for (const step of job.steps) {
                    if (step.dataArtifacts) {
                      for (const artifact of step.dataArtifacts) {
                        artifactNames.add(artifact.name);
                      }
                    }
                  }
                }

                if (artifactNames.size > 0) {
                  wfLogger.info("");
                  wfLogger.info("View produced data:");
                  wfLogger.info(
                    "  swamp data list --workflow {workflowName}",
                    { workflowName },
                  );
                  for (const name of artifactNames) {
                    wfLogger.info(
                      "  swamp data get --workflow {workflowName} {artifactName}",
                      { workflowName, artifactName: name },
                    );
                  }
                }
              }
            } else {
              renderWorkflowRun(e.run, ctx.outputMode);
            }
            ctx.logger.debug`Workflow run completed: status=${e.run.status}`;
            if (e.run.status === "failed") {
              failed = true;
            }
          },
          error: (e) => {
            throw new UserError(e.error.message);
          },
        }),
      );

      if (failed) {
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

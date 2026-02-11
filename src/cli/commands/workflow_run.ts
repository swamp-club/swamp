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
  type JobRunData,
  renderWorkflowRun,
  type StepArtifactsData,
  type StepRunData,
  type WorkflowRunData,
} from "../../presentation/output/workflow_run_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  type ExecutionProgressCallback,
  type ImplicitDependencyMap,
  WorkflowExecutionService,
} from "../../domain/workflows/execution_service.ts";
import type {
  StepRun,
  WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { createLogProgressCallback } from "../../presentation/output/log_progress_callback.ts";
import { parseInputs } from "../input_parser.ts";
import { InputValidationService } from "../../domain/inputs/mod.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Extracts artifact data from a step's output for verbose mode.
 * Only returns artifacts if there's actual content to display.
 */
function extractStepArtifacts(step: StepRun): StepArtifactsData | undefined {
  if (step.output === undefined || step.output === null) {
    return undefined;
  }

  const output = step.output as Record<string, unknown>;

  // Shell command output: { stdout, exitCode }
  if (
    typeof output.stdout === "string" || typeof output.exitCode === "number"
  ) {
    const artifacts: StepArtifactsData = {};
    if (output.stdout) artifacts.stdout = output.stdout as string;
    if (output.stderr) artifacts.stderr = output.stderr as string;
    if (typeof output.exitCode === "number") {
      artifacts.exitCode = output.exitCode;
    }

    // Only return if there's actual content
    return Object.keys(artifacts).length > 0 ? artifacts : undefined;
  }

  // Model method output: { type, model, method, resourceId, resourcePath, resourceAttributes }
  if (output.type === "model_method") {
    const attrs = output.resourceAttributes as
      | Record<string, unknown>
      | undefined;
    // Only include if attributes exist and have content
    if (attrs && Object.keys(attrs).length > 0) {
      return { dataAttributes: attrs };
    }
    return undefined;
  }

  return undefined;
}

/**
 * Converts a WorkflowRun to WorkflowRunData for presentation.
 */
function toRunData(
  run: WorkflowRun,
  path?: string,
  implicitDeps?: ImplicitDependencyMap,
  verbose?: boolean,
): WorkflowRunData {
  const startTime = run.startedAt?.getTime();
  const endTime = run.completedAt?.getTime();

  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    jobs: run.jobs.map((job): JobRunData => {
      const jobStart = job.startedAt?.getTime();
      const jobEnd = job.completedAt?.getTime();
      const jobImplicitDeps = implicitDeps?.get(job.jobName);

      return {
        name: job.jobName,
        status: job.status,
        steps: job.steps.map((step): StepRunData => {
          const stepStart = step.startedAt?.getTime();
          const stepEnd = step.completedAt?.getTime();
          const stepImplicitDeps = jobImplicitDeps?.get(step.stepName);

          const stepData: StepRunData = {
            name: step.stepName,
            status: step.status,
            error: step.error,
            duration: stepStart && stepEnd ? stepEnd - stepStart : undefined,
            implicitDependencies: stepImplicitDeps,
          };

          // Include artifacts in verbose mode
          if (verbose) {
            const artifacts = extractStepArtifacts(step);
            if (artifacts) {
              stepData.artifacts = artifacts;
            }
          }

          // Include data artifacts if present
          if (step.dataArtifacts && step.dataArtifacts.length > 0) {
            stepData.dataArtifacts = step.dataArtifacts.map((a) => ({
              dataId: a.dataId,
              name: a.name,
              version: a.version,
              tags: a.tags,
            }));
          }

          return stepData;
        }),
        duration: jobStart && jobEnd ? jobEnd - jobStart : undefined,
      };
    }),
    duration: startTime && endTime ? endTime - startTime : undefined,
    path,
  };
}

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
  .option("--input <json:string>", "Input values as JSON")
  .option("--input-file <file:string>", "Input values from YAML file")
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

    const executionService = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      repoDir,
    );

    const lastEvaluated = options.lastEvaluated as boolean;

    // Parse input values
    const { inputs } = await parseInputs({
      input: options.input as string | undefined,
      inputFile: options.inputFile as string | undefined,
    });

    try {
      // Look up workflow first to get its data
      const workflow = await workflowRepo.findByName(workflowIdOrName) ??
        await workflowRepo.findById(createWorkflowId(workflowIdOrName));

      if (!workflow) {
        throw new UserError(`Workflow not found: ${workflowIdOrName}`);
      }

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
          throw new Error(`Input validation failed:\n${errorMessages}`);
        }
        // Use inputs with defaults applied
        Object.assign(inputs, inputsWithDefaults);
      }

      if (ctx.outputMode === "json") {
        // JSON mode: execute with debug logging, output final result
        let capturedImplicitDeps: ImplicitDependencyMap | undefined;

        const progress: ExecutionProgressCallback = {
          onImplicitDependencies: (deps) => {
            capturedImplicitDeps = deps;
          },
          onJobStart: (_run, jobName) => {
            ctx.logger.debug`Job started: ${jobName}`;
          },
          onStepStart: (_run, jobName, stepName) => {
            ctx.logger.debug`Step started: ${jobName}/${stepName}`;
          },
          onStepFail: (_run, jobName, stepName, error) => {
            ctx.logger.debug`Step failed: ${jobName}/${stepName}: ${error}`;
          },
        };

        const run = await executionService.execute(workflow.name, progress, {
          lastEvaluated,
          inputs,
        });

        // Get the path for the run
        const path = runRepo.getPath(workflow.id, run.id);

        const data = toRunData(
          run,
          path,
          capturedImplicitDeps,
          ctx.verbosity === "verbose",
        );
        renderWorkflowRun(data, ctx.outputMode);

        ctx.logger.debug`Workflow run completed: status=${run.status}`;

        // Exit with code 1 if workflow failed
        if (run.status === "failed") {
          Deno.exit(1);
        }
      } else {
        // Default: LogTape-based output with step logging
        const progress = createLogProgressCallback(workflow.name);
        const run = await executionService.execute(workflow.name, progress, {
          enableStepLogging: true,
          lastEvaluated,
          inputs,
        });

        ctx.logger.debug`Workflow run completed: status=${run.status}`;

        // Exit with code 1 if workflow failed
        if (run.status === "failed") {
          Deno.exit(1);
        }
      }
    } catch (error) {
      if (error instanceof UserError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`Workflow execution failed: ${message}`);
    }
  });

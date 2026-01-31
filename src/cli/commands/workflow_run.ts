import { Command } from "@cliffy/command";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  type JobRunData,
  renderWorkflowRun,
  type StepArtifactsData,
  type StepRunData,
  type WorkflowRunData,
} from "../../presentation/output/workflow_run_output.tsx";
import { renderWorkflowExecution } from "../../presentation/output/workflow_execution_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import {
  type ExecutionProgressCallback,
  type ImplicitDependencyMap,
  WorkflowExecutionService,
} from "../../domain/workflows/execution_service.ts";
import type {
  StepRun,
  WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import { createStreamProgressCallback } from "../../presentation/output/stream_output.ts";

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
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, "workflow-run");
    ctx.logger.debug`Running workflow: ${workflowIdOrName}`;

    const repoDir = options.repoDir ?? ".";
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const runRepo = new YamlWorkflowRunRepository(repoDir);

    const executionService = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      repoDir,
    );

    try {
      // Look up workflow first to get its data
      const workflow = await workflowRepo.findByName(workflowIdOrName) ??
        await workflowRepo.findById(createWorkflowId(workflowIdOrName));

      if (!workflow) {
        throw new Error(`Workflow not found: ${workflowIdOrName}`);
      }

      if (ctx.outputMode === "stream") {
        // Stream mode: real-time colored output
        const progress = createStreamProgressCallback();
        const run = await executionService.execute(workflow.name, progress);

        ctx.logger.debug`Workflow run completed: status=${run.status}`;

        // Exit with code 1 if workflow failed
        if (run.status === "failed") {
          Deno.exit(1);
        }
      } else if (ctx.outputMode === "interactive") {
        // Interactive mode: use the new live dashboard
        const workflowData = workflow.toData();
        // Remove undefined values since YAML can't stringify them
        const cleanData = JSON.parse(JSON.stringify(workflowData));
        const workflowYaml = stringifyYaml(
          cleanData as Record<string, unknown>,
        );

        const executeWorkflow = async (
          progress: ExecutionProgressCallback,
        ): Promise<WorkflowRun> => {
          return await executionService.execute(workflow.name, progress);
        };

        const data = await renderWorkflowExecution(
          { workflow: cleanData, workflowYaml },
          executeWorkflow,
          ctx.outputMode,
        );

        // Get the path for the run
        const path = runRepo.getPath(workflow.id, createWorkflowRunId(data.id));
        data.path = path;

        ctx.logger.debug`Workflow run completed: status=${data.status}`;

        // Exit with code 1 if workflow failed
        if (data.status === "failed") {
          Deno.exit(1);
        }
      } else {
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

        const run = await executionService.execute(workflow.name, progress);

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
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Workflow execution failed: ${message}`);
    }
  });

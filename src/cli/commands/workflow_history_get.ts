import { Command } from "@cliffy/command";
import {
  type JobRunData,
  renderWorkflowRun,
  type StepRunData,
  type WorkflowRunData,
} from "../../presentation/output/workflow_run_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts a WorkflowRun to WorkflowRunData for presentation.
 */
function toRunData(run: WorkflowRun, path?: string): WorkflowRunData {
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

      return {
        name: job.jobName,
        status: job.status,
        steps: job.steps.map((step): StepRunData => {
          const stepStart = step.startedAt?.getTime();
          const stepEnd = step.completedAt?.getTime();

          return {
            name: step.stepName,
            status: step.status,
            error: step.error,
            duration: stepStart && stepEnd ? stepEnd - stepStart : undefined,
          };
        }),
        duration: jobStart && jobEnd ? jobEnd - jobStart : undefined,
      };
    }),
    duration: startTime && endTime ? endTime - startTime : undefined,
    path,
  };
}

export const workflowHistoryGetCommand = new Command()
  .name("get")
  .description("Show the latest run for a workflow")
  .arguments("<workflow_id_or_name:workflow_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, [
      "workflow",
      "history",
      "get",
    ]);
    ctx.logger.debug`Getting latest run for workflow: ${workflowIdOrName}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const workflowRepo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;

    // Look up the workflow first
    const workflow = await workflowRepo.findByName(workflowIdOrName) ??
      await workflowRepo.findById(createWorkflowId(workflowIdOrName));

    if (!workflow) {
      throw new UserError(`Workflow not found: ${workflowIdOrName}`);
    }

    ctx.logger.debug`Found workflow: id=${workflow.id}, name=${workflow.name}`;

    // Get the latest run for this workflow
    const latestRun = await runRepo.findLatestByWorkflowId(workflow.id);

    if (!latestRun) {
      throw new UserError(`No runs found for workflow: ${workflow.name}`);
    }

    ctx.logger
      .debug`Found latest run: id=${latestRun.id}, status=${latestRun.status}`;

    // Get the path for the run
    const path = runRepo.getPath(workflow.id, latestRun.id);

    const data = toRunData(latestRun, path);
    renderWorkflowRun(data, ctx.outputMode);

    ctx.logger.debug("Workflow history get command completed");
  });

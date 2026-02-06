import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { UserError } from "../../domain/errors.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Data structure for step log output.
 */
interface StepLogData {
  stepName: string;
  status: string;
  error?: string;
  output?: unknown;
}

/**
 * Data structure for job log output.
 */
interface JobLogData {
  jobName: string;
  status: string;
  steps: StepLogData[];
}

/**
 * Data structure for workflow run logs output.
 */
interface WorkflowRunLogsData {
  runId: string;
  workflowName: string;
  status: string;
  jobs: JobLogData[];
}

export const workflowHistoryLogsCommand = new Command()
  .name("logs")
  .description("Show logs/output for a workflow run")
  .arguments("<run_id_or_workflow:workflow_name> [step:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--job <name:string>", "Filter by job name")
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (
    options: AnyOptions,
    runIdOrWorkflow: string,
    stepArg?: string,
  ) {
    const ctx = createContext(
      options as GlobalOptions,
      ["workflow", "history", "logs"],
    );
    ctx.logger.debug`Getting logs for workflow run: ${runIdOrWorkflow}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const runRepo = repoContext.workflowRunRepo;
    const workflowRepo = repoContext.workflowRepo;

    let run: WorkflowRun | undefined;

    // Try partial ID matching first if input looks like an ID
    if (isPartialId(runIdOrWorkflow)) {
      const allRuns = await runRepo.findAllGlobal();
      const result = matchByPartialId(
        allRuns.map((r) => ({ id: r.run.id, item: r })),
        runIdOrWorkflow,
      );

      if (result.status === "found") {
        run = result.match.run;
      } else if (result.status === "ambiguous") {
        throw new UserError(
          `Ambiguous ID prefix "${runIdOrWorkflow}" matches:\n` +
            result.matches.map((m) => `  ${m.id}`).join("\n"),
        );
      }
      // not_found: fall through to workflow name lookup
    }

    // If not found as run ID, try as workflow name and get latest run
    if (!run) {
      const workflow = await workflowRepo.findByName(runIdOrWorkflow) ??
        await workflowRepo.findById(createWorkflowId(runIdOrWorkflow));

      if (!workflow) {
        throw new UserError(
          `No workflow run or workflow found: ${runIdOrWorkflow}`,
        );
      }

      const latestRun = await runRepo.findLatestByWorkflowId(workflow.id);
      if (!latestRun) {
        throw new UserError(
          `No runs found for workflow: ${workflow.name}`,
        );
      }

      run = latestRun;
      ctx.logger
        .debug`Using latest run for workflow ${workflow.name}: ${run.id}`;
    }

    // Filter jobs if --job is specified
    let jobs = [...run.jobs];
    if (options.job) {
      jobs = jobs.filter((job) => job.jobName === options.job);
      if (jobs.length === 0) {
        const availableJobs = run.jobs.map((j) => j.jobName).join(", ");
        throw new UserError(
          `Job "${options.job}" not found. Available jobs: ${
            availableJobs || "(none)"
          }`,
        );
      }
    }

    // If a specific step is requested, filter to that step
    if (stepArg) {
      let foundStep = false;
      for (const job of jobs) {
        const step = job.getStep(stepArg);
        if (step) {
          foundStep = true;
          // Output only this step
          if (ctx.outputMode === "json") {
            console.log(
              JSON.stringify(
                {
                  runId: run.id,
                  workflowName: run.workflowName,
                  jobName: job.jobName,
                  stepName: step.stepName,
                  status: step.status,
                  error: step.error,
                  output: step.output,
                },
                null,
                2,
              ),
            );
          } else {
            // Interactive: print the step output
            console.log(`Step: ${step.stepName}`);
            console.log(`Status: ${step.status}`);
            if (step.error) {
              console.log(`Error: ${step.error}`);
            }
            if (step.output !== undefined) {
              console.log("Output:");
              if (typeof step.output === "string") {
                console.log(step.output);
              } else if (
                typeof step.output === "object" && step.output !== null
              ) {
                const output = step.output as {
                  stdout?: string;
                  stderr?: string;
                };
                if (output.stdout) {
                  console.log(output.stdout);
                }
                if (output.stderr) {
                  console.error(output.stderr);
                }
              } else {
                console.log(JSON.stringify(step.output, null, 2));
              }
            }
          }
          break;
        }
      }
      if (!foundStep) {
        const availableSteps: string[] = [];
        for (const job of jobs) {
          for (const step of job.steps) {
            availableSteps.push(`${job.jobName}/${step.stepName}`);
          }
        }
        throw new UserError(
          `Step "${stepArg}" not found. Available steps: ${
            availableSteps.join(", ") || "(none)"
          }`,
        );
      }
    } else {
      // Output all jobs and steps
      const logsData: WorkflowRunLogsData = {
        runId: run.id,
        workflowName: run.workflowName,
        status: run.status,
        jobs: jobs.map((job): JobLogData => ({
          jobName: job.jobName,
          status: job.status,
          steps: job.steps.map((step): StepLogData => ({
            stepName: step.stepName,
            status: step.status,
            error: step.error,
            output: step.output,
          })),
        })),
      };

      if (ctx.outputMode === "json") {
        console.log(JSON.stringify(logsData, null, 2));
      } else {
        // Interactive: print the logs
        console.log(`Workflow: ${run.workflowName}`);
        console.log(`Run ID: ${run.id}`);
        console.log(`Status: ${run.status}`);
        console.log("");

        for (const job of logsData.jobs) {
          console.log(`Job: ${job.jobName} [${job.status}]`);
          for (const step of job.steps) {
            console.log(`  Step: ${step.stepName} [${step.status}]`);
            if (step.error) {
              console.log(`    Error: ${step.error}`);
            }
            if (step.output !== undefined) {
              if (
                typeof step.output === "object" && step.output !== null
              ) {
                const output = step.output as {
                  stdout?: string;
                  stderr?: string;
                };
                if (output.stdout) {
                  const lines = output.stdout.split("\n");
                  for (const line of lines) {
                    console.log(`    ${line}`);
                  }
                }
                if (output.stderr) {
                  const lines = output.stderr.split("\n");
                  for (const line of lines) {
                    console.error(`    ${line}`);
                  }
                }
              }
            }
          }
          console.log("");
        }
      }
    }

    ctx.logger.debug("Workflow history logs command completed");
  });

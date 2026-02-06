import { Command } from "@cliffy/command";
import {
  renderWorkflowCreate,
  type WorkflowCreateData,
} from "../../presentation/output/workflow_create_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowCreateCommand = new Command()
  .description("Create a new workflow")
  .arguments("<name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, name: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "create"]);
    ctx.logger.debug`Creating workflow: name=${name}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const repo = repoContext.workflowRepo;

    // Check if name already exists
    const existing = await repo.findByName(name);
    if (existing) {
      throw new Error(`Workflow with name '${name}' already exists`);
    }

    // Create workflow with a default job (schema requires at least one job)
    const defaultJob = Job.create({
      name: "main",
      description: "Main job (edit or replace)",
      steps: [
        Step.create({
          name: "example",
          description: "Example step (edit or replace)",
          task: StepTask.shell("echo", { args: ["Hello from workflow!"] }),
        }),
      ],
    });

    const workflow = Workflow.create({
      name,
      jobs: [defaultJob],
    });
    await repo.save(workflow);

    ctx.logger.debug`Created workflow with ID: ${workflow.id}`;

    const data: WorkflowCreateData = {
      id: workflow.id,
      name: workflow.name,
      path: repo.getPath(workflow.id),
    };

    renderWorkflowCreate(data, ctx.outputMode);
    ctx.logger.debug("Workflow create command completed");
  });

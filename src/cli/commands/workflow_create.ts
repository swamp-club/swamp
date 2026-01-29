import { Command } from "@cliffy/command";
import {
  type WorkflowCreateData,
  renderWorkflowCreate,
} from "../../presentation/output/workflow_create_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowCreateCommand = new Command()
  .description("Create a new workflow")
  .arguments("<name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, name: string) {
    const ctx = createContext(options as GlobalOptions, "workflow-create");
    ctx.logger.debug`Creating workflow: name=${name}`;

    const repoDir = options.repoDir ?? ".";
    const repo = new YamlWorkflowRepository(repoDir);

    // Check if name already exists
    const existing = await repo.findByName(name);
    if (existing) {
      throw new Error(`Workflow with name '${name}' already exists`);
    }

    // Create and save the workflow (empty, to be edited)
    const workflow = Workflow.create({ name });
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

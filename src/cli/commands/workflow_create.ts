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
  renderWorkflowCreate,
  type WorkflowCreateData,
  type WorkflowJobData,
} from "../../presentation/output/workflow_create_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
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
      throw new UserError(`Workflow with name '${name}' already exists`);
    }

    // Create workflow with a default job (schema requires at least one job)
    const defaultJob = Job.create({
      name: "main",
      description: "Main job (edit or replace)",
      steps: [
        Step.create({
          name: "example",
          description: "Example step (edit or replace)",
          task: StepTask.model("example-model", "run"),
        }),
      ],
    });

    const workflow = Workflow.create({
      name,
      jobs: [defaultJob],
    });
    await repo.save(workflow);

    ctx.logger.debug`Created workflow with ID: ${workflow.id}`;

    const jobs: WorkflowJobData[] = workflow.jobs.map((job) => ({
      name: job.name,
      description: job.description ?? "",
      steps: job.steps.map((step) => ({
        name: step.name,
        description: step.description ?? "",
        taskType: step.task.data.type,
      })),
    }));

    const data: WorkflowCreateData = {
      id: workflow.id,
      name: workflow.name,
      path: repo.getPath(workflow.id),
      jobs,
    };

    renderWorkflowCreate(data, ctx.outputMode);
    ctx.logger.debug("Workflow create command completed");
  });

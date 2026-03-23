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

import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { alreadyExists } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structures for the workflow create output.
 */
export interface WorkflowCreateStepData {
  name: string;
  description: string;
  taskType: string;
}

export interface WorkflowCreateJobData {
  name: string;
  description: string;
  steps: WorkflowCreateStepData[];
}

export interface WorkflowCreateData {
  id: string;
  name: string;
  path: string;
  jobs: WorkflowCreateJobData[];
}

export type WorkflowCreateEvent =
  | { kind: "creating" }
  | { kind: "completed"; data: WorkflowCreateData }
  | { kind: "error"; error: SwampError };

/** Input for the workflow create operation. */
export interface WorkflowCreateInput {
  name: string;
}

/** Dependencies for the workflow create operation. */
export interface WorkflowCreateDeps {
  findByName: (name: string) => Promise<Workflow | null>;
  save: (workflow: Workflow) => Promise<void>;
  getPath: (id: WorkflowId) => string;
}

/** Wires real infrastructure into WorkflowCreateDeps. */
export function createWorkflowCreateDeps(
  repoDir: string,
): WorkflowCreateDeps {
  const repo = new YamlWorkflowRepository(repoDir);
  return {
    findByName: (name) => repo.findByName(name),
    save: (workflow) => repo.save(workflow),
    getPath: (id) => repo.getPath(id),
  };
}

/** Creates a new workflow with default job structure. */
export async function* workflowCreate(
  ctx: LibSwampContext,
  deps: WorkflowCreateDeps,
  input: WorkflowCreateInput,
): AsyncIterable<WorkflowCreateEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.create",
    { "workflow.name": input.name },
    (async function* () {
      yield { kind: "creating" };

      ctx.logger.debug`Creating workflow: name=${input.name}`;

      // Check name uniqueness
      const existing = await deps.findByName(input.name);
      if (existing) {
        yield {
          kind: "error",
          error: alreadyExists("Workflow", input.name),
        };
        return;
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
        name: input.name,
        jobs: [defaultJob],
      });

      await deps.save(workflow);

      ctx.logger.debug`Created workflow with ID: ${workflow.id}`;

      const jobs: WorkflowCreateJobData[] = workflow.jobs.map((job) => ({
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
        path: deps.getPath(workflow.id),
        jobs,
      };

      yield { kind: "completed", data };
    })(),
  );
}

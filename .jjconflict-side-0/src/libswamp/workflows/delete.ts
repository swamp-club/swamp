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

import type { Workflow } from "../../domain/workflows/workflow.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Preview data returned before confirmation. */
export interface WorkflowDeletePreview {
  id: string;
  name: string;
  workflowPath: string;
  runCount: number;
}

/** Data structure for the workflow delete completed event. */
export interface WorkflowDeleteData {
  id: string;
  name: string;
  workflowPath: string;
  runsDeleted: number;
}

export type WorkflowDeleteEvent =
  | { kind: "deleting" }
  | { kind: "completed"; data: WorkflowDeleteData }
  | { kind: "error"; error: SwampError };

/** Input for the workflow delete operation. */
export interface WorkflowDeleteInput {
  workflowIdOrName: string;
}

/** Dependencies for the workflow delete operation. */
export interface WorkflowDeleteDeps {
  findById: (id: WorkflowId) => Promise<Workflow | null>;
  findByName: (name: string) => Promise<Workflow | null>;
  getPath: (id: WorkflowId) => string;
  pathExists: (path: string) => Promise<boolean>;
  countRuns: (workflowId: WorkflowId) => Promise<number>;
  deleteRuns: (workflowId: WorkflowId) => Promise<number>;
  deleteEvaluated: (workflowId: WorkflowId) => Promise<void>;
  deleteWorkflow: (workflowId: WorkflowId) => Promise<void>;
}

/** Wires real infrastructure into WorkflowDeleteDeps. */
export function createWorkflowDeleteDeps(repoDir: string): WorkflowDeleteDeps {
  const workflowRepo = new YamlWorkflowRepository(repoDir);
  const workflowRunRepo = new YamlWorkflowRunRepository(repoDir);
  const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(repoDir);
  return {
    findById: (id) => workflowRepo.findById(id),
    findByName: (name) => workflowRepo.findByName(name),
    getPath: (id) => workflowRepo.getPath(id),
    pathExists: async (path) => {
      try {
        await Deno.stat(path);
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
    countRuns: async (workflowId) => {
      const runs = await workflowRunRepo.findAllByWorkflowId(workflowId);
      return runs.length;
    },
    deleteRuns: (workflowId) =>
      workflowRunRepo.deleteAllByWorkflowId(workflowId),
    deleteEvaluated: (workflowId) => evaluatedWorkflowRepo.delete(workflowId),
    deleteWorkflow: (workflowId) => workflowRepo.delete(workflowId),
  };
}

/** Helper to look up a workflow by ID or name. */
async function findWorkflow(
  deps: WorkflowDeleteDeps,
  idOrName: string,
): Promise<Workflow | null> {
  if (isUuid(idOrName)) {
    return await deps.findById(createWorkflowId(idOrName));
  }
  return await deps.findByName(idOrName);
}

/** Gathers preview info for the workflow delete operation. */
export async function workflowDeletePreview(
  ctx: LibSwampContext,
  deps: WorkflowDeleteDeps,
  input: WorkflowDeleteInput,
): Promise<WorkflowDeletePreview> {
  ctx.logger.debug`Looking up workflow: ${input.workflowIdOrName}`;
  const workflow = await findWorkflow(deps, input.workflowIdOrName);
  if (!workflow) {
    throw notFound("Workflow", input.workflowIdOrName);
  }

  const workflowPath = deps.getPath(workflow.id);

  // Guard against deleting extension-only workflows
  const exists = await deps.pathExists(workflowPath);
  if (!exists) {
    throw validationFailed(
      `Cannot delete extension workflow '${workflow.name}'. Extension workflows are read-only. To remove it, delete the source file directly.`,
    );
  }

  const runCount = await deps.countRuns(workflow.id);

  return {
    id: workflow.id,
    name: workflow.name,
    workflowPath,
    runCount,
  };
}

/** Deletes a workflow and its run history. */
export async function* workflowDelete(
  ctx: LibSwampContext,
  deps: WorkflowDeleteDeps,
  input: WorkflowDeleteInput,
): AsyncIterable<WorkflowDeleteEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.delete",
    { "workflow.id_or_name": input.workflowIdOrName },
    (async function* () {
      yield { kind: "deleting" };

      const workflow = await findWorkflow(deps, input.workflowIdOrName);
      if (!workflow) {
        yield {
          kind: "error",
          error: notFound("Workflow", input.workflowIdOrName),
        };
        return;
      }

      const workflowPath = deps.getPath(workflow.id);

      // Delete runs
      ctx.logger.debug`Deleting workflow runs`;
      const runsDeleted = await deps.deleteRuns(workflow.id);

      // Delete evaluated workflow
      ctx.logger.debug`Deleting evaluated workflow`;
      await deps.deleteEvaluated(workflow.id);

      // Delete workflow
      ctx.logger.debug`Deleting workflow: ${workflow.id}`;
      await deps.deleteWorkflow(workflow.id);

      yield {
        kind: "completed",
        data: {
          id: workflow.id,
          name: workflow.name,
          workflowPath,
          runsDeleted,
        },
      };
    })(),
  );
}

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
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the workflow get output.
 */
export interface WorkflowGetData {
  id: string;
  name: string;
  description?: string;
  version: number;
  jobs: {
    name: string;
    description?: string;
    steps: {
      name: string;
      description?: string;
      task: {
        type: string;
        [key: string]: unknown;
      };
    }[];
  }[];
  path: string;
}

export type WorkflowGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowGetData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the workflow get operation. */
export interface WorkflowGetDeps {
  findWorkflow: (idOrName: string) => Promise<Workflow | null>;
  getWorkflowPath: (id: WorkflowId) => string;
}

/**
 * UUID v4 regex pattern for detecting if an argument is a UUID.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Wires real infrastructure into WorkflowGetDeps. */
export function createWorkflowGetDeps(
  workflowRepo: WorkflowRepository,
): WorkflowGetDeps {
  return {
    findWorkflow: async (idOrName) => {
      if (isUuid(idOrName)) {
        return await workflowRepo.findById(createWorkflowId(idOrName));
      }
      return await workflowRepo.findByName(idOrName);
    },
    getWorkflowPath: (id) => workflowRepo.getPath(id),
  };
}

/** Retrieves workflow details by ID or name. */
export async function* workflowGet(
  _ctx: LibSwampContext,
  deps: WorkflowGetDeps,
  workflowIdOrName: string,
): AsyncIterable<WorkflowGetEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.get",
    { "workflow.id_or_name": workflowIdOrName },
    (async function* () {
      yield { kind: "resolving" };

      const workflow = await deps.findWorkflow(workflowIdOrName);

      if (!workflow) {
        yield { kind: "error", error: notFound("Workflow", workflowIdOrName) };
        return;
      }

      const data: WorkflowGetData = {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        jobs: workflow.jobs.map((job) => ({
          name: job.name,
          description: job.description,
          steps: job.steps.map((step) => ({
            name: step.name,
            description: step.description,
            task: step.task.toData(),
          })),
        })),
        path: deps.getWorkflowPath(workflow.id),
      };

      yield { kind: "completed", data };
    })(),
  );
}

/** Checks if a string looks like a UUID. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

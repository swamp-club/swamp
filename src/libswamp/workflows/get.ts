// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import type { InputsSchema } from "../../domain/definitions/definition.ts";
import type { ReportSelection } from "../../domain/reports/report_selection.ts";
import type { TriggerConditionData } from "../../domain/workflows/trigger_condition.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../../domain/workflows/workflow_lookup.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";
import { type LookupOptions, selectLookup } from "../lookup_by_id.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface WorkflowGetJobDependency {
  job: string;
  condition: TriggerConditionData;
}

export interface WorkflowGetStepDependency {
  step: string;
  condition: TriggerConditionData;
}

/**
 * Data structure for the workflow get output.
 */
export interface WorkflowGetData {
  id: string;
  name: string;
  description?: string;
  version: number;
  inputs?: InputsSchema;
  trigger?: { schedule?: string; inputs?: Record<string, unknown> };
  tags: Record<string, string>;
  reports?: ReportSelection;
  jobs: {
    name: string;
    description?: string;
    dependsOn: WorkflowGetJobDependency[];
    steps: {
      name: string;
      description?: string;
      dependsOn: WorkflowGetStepDependency[];
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
  /** Looks up by name, then by exact id. */
  findWorkflow: (idOrName: string) => Promise<Workflow | null>;
  /** Looks up by exact id only; required for a `byId` request. */
  findWorkflowById?: (id: string) => Promise<Workflow | null>;
  getWorkflowPath: (id: WorkflowId) => string;
}

/** Wires real infrastructure into WorkflowGetDeps. */
export function createWorkflowGetDeps(
  workflowRepo: WorkflowRepository,
): WorkflowGetDeps {
  return {
    findWorkflow: (idOrName) => findWorkflowByIdOrName(workflowRepo, idOrName),
    findWorkflowById: (id) => findWorkflowById(workflowRepo, id),
    getWorkflowPath: (id) => workflowRepo.getPath(id),
  };
}

/** Retrieves workflow details by ID or name. */
export async function* workflowGet(
  _ctx: LibSwampContext,
  deps: WorkflowGetDeps,
  workflowIdOrName: string,
  options: LookupOptions = {},
): AsyncIterable<WorkflowGetEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.get",
    { "workflow.id_or_name": workflowIdOrName },
    (async function* () {
      yield { kind: "resolving" };

      const findWorkflow = selectLookup(
        "workflow get",
        options.byId,
        deps.findWorkflow,
        deps.findWorkflowById,
      );
      const workflow = await findWorkflow(workflowIdOrName);

      if (!workflow) {
        yield { kind: "error", error: notFound("Workflow", workflowIdOrName) };
        return;
      }

      const data: WorkflowGetData = {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        inputs: workflow.inputs,
        trigger: workflow.trigger,
        tags: workflow.tags,
        reports: workflow.reports,
        jobs: workflow.jobs.map((job) => ({
          name: job.name,
          description: job.description,
          dependsOn: job.dependsOn.map((d) => ({
            job: d.job,
            condition: d.condition.toData(),
          })),
          steps: job.steps.map((step) => ({
            name: step.name,
            description: step.description,
            dependsOn: step.dependsOn.map((d) => ({
              step: d.step,
              condition: d.condition.toData(),
            })),
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
export { isUuid };

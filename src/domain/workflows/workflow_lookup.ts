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

import type { Workflow } from "./workflow.ts";
import type { WorkflowRun } from "./workflow_run.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "./repositories.ts";
import { createWorkflowId } from "./workflow_id.ts";
import { isUuid } from "../models/model_lookup.ts";
import { UserError } from "../errors.ts";

/**
 * a workflow may be named with another workflow's UUID, so the name wins; the
 * id lookup runs only for a UUID-shaped string since a missed id lookup scans
 * every workflow file
 */
export async function findWorkflowByIdOrName(
  workflowRepo: Pick<WorkflowRepository, "findByName" | "findById">,
  idOrName: string,
): Promise<Workflow | null> {
  const byName = await workflowRepo.findByName(idOrName);
  if (byName) return byName;
  if (!isUuid(idOrName)) return null;
  return await workflowRepo.findById(createWorkflowId(idOrName));
}

/**
 * ids are not guaranteed unique (a copied file keeps its id), so with
 * expectedName the workflow is found by that name as authorization found it and
 * accepted only if it still has this id
 */
export async function findWorkflowById(
  workflowRepo: Pick<WorkflowRepository, "findById" | "findByName">,
  id: string,
  expectedName?: string,
): Promise<Workflow | null> {
  if (!isUuid(id)) return null;
  if (expectedName !== undefined) {
    const byName = await workflowRepo.findByName(expectedName);
    return byName?.id === id ? byName : null;
  }
  return await workflowRepo.findById(createWorkflowId(id));
}

/** null for a non-UUID id, so an unvalidated id never names a runs directory */
export async function latestRunForWorkflow(
  workflowRunRepo: Pick<WorkflowRunRepository, "findLatestByWorkflowId">,
  workflowId: string,
): Promise<WorkflowRun | null> {
  if (!isUuid(workflowId)) return null;
  return await workflowRunRepo.findLatestByWorkflowId(
    createWorkflowId(workflowId),
  );
}

export function createLatestRunResolver(
  workflowRepo: Pick<WorkflowRepository, "findByName" | "findById">,
  workflowRunRepo: Pick<WorkflowRunRepository, "findLatestByWorkflowId">,
): (workflow: string) => Promise<string | null> {
  return async (idOrName) => {
    const workflow = await findWorkflowByIdOrName(workflowRepo, idOrName);
    if (!workflow) throw new UserError(`Workflow not found: ${idOrName}`);
    const run = await latestRunForWorkflow(workflowRunRepo, workflow.id);
    return run?.id ?? null;
  };
}

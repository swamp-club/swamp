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
import type { WorkflowRepository } from "./repositories.ts";
import { createWorkflowId } from "./workflow_id.ts";
import { isUuid } from "../models/model_lookup.ts";

/**
 * Finds a workflow by name, then by exact id — the one lookup precedence for
 * workflows, matching findDefinitionByIdOrName for models. A workflow may be
 * named with another workflow's UUID; the name wins.
 *
 * The id lookup only runs for a UUID-shaped string: a workflow id is always a
 * UUID, and a missed id lookup scans every workflow file.
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
 * Finds a workflow by exact id only, for callers that already resolved the
 * workflow and must act on exactly that one.
 *
 * With `expectedName` — the name the caller authorized — the workflow must
 * have both: ids are not guaranteed unique (a copied file keeps its id), so it
 * is found by that name, as authorization found it, and accepted only if it
 * still has this id. Otherwise the authorized workflow is gone.
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

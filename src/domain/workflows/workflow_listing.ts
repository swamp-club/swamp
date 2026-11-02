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

import type { WorkflowRepository } from "./repositories.ts";
import { type Workflow, workflowDeclaresInputs } from "./workflow.ts";

export interface WorkflowListing {
  readonly id: string;
  readonly name: string;
  readonly declaresInputs: boolean;
}

export function workflowListingOf(workflow: Workflow): WorkflowListing {
  return Object.freeze({
    id: workflow.id,
    name: workflow.name,
    declaresInputs: workflowDeclaresInputs(workflow.inputs),
  });
}

export async function listWorkflows(
  repo: WorkflowRepository,
): Promise<WorkflowListing[]> {
  return repo.findAllListings
    ? await repo.findAllListings()
    : (await repo.findAll()).map(workflowListingOf);
}

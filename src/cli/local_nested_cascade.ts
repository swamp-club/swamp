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

import type { RunTrackerRepository } from "../domain/models/run_tracker_repository.ts";
import type { EvaluatedWorkflowLookup } from "../domain/workflows/abort_settlement.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../domain/workflows/repositories.ts";
import type { WorkflowRunClaims } from "../domain/workflows/run_claim.ts";
import { localOwnerLiveness } from "../infrastructure/persistence/run_tracker_store.ts";
import {
  createNestedCascade,
  type NestedCascade,
} from "../libswamp/workflows/nested_cascade.ts";

/** What a local command's cascade reads and writes. */
export interface LocalNestedCascadeDeps {
  workflowRepo: Pick<WorkflowRepository, "findById">;
  runRepo: Pick<WorkflowRunRepository, "findById" | "save">;
  runClaims: WorkflowRunClaims;
  findEvaluatedWorkflow: EvaluatedWorkflowLookup;
  /** Without it, a child's owner cannot be looked up and is taken as gone. */
  runTracker?: RunTrackerRepository;
}

/**
 * The cascade of a local command (swamp-club#2867): it cancels the suspended
 * nested runs an ended run waited on. A child a serve instance owns is left
 * to that instance, and a child another local process is running is left to
 * its own cancel; both are reported with the command that cancels them.
 */
export function localNestedCascade(
  deps: LocalNestedCascadeDeps,
): NestedCascade {
  return createNestedCascade({
    ...deps,
    liveness: localOwnerLiveness(),
    maySettle: (child) => child.instanceId === undefined,
  });
}

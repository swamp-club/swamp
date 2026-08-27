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

import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import { inputsMatch } from "../../domain/workflows/input_matching.ts";

export interface SupersedeResult {
  cancelledRunIds: string[];
}

export async function supersedeSuspendedRuns(
  workflowId: WorkflowId,
  newInputs: Readonly<Record<string, unknown>>,
  findSuspendedRuns: (workflowId: WorkflowId) => Promise<WorkflowRun[]>,
  runRepo: WorkflowRunRepository,
): Promise<SupersedeResult> {
  const suspendedRuns = await findSuspendedRuns(workflowId);
  const cancelledRunIds: string[] = [];

  for (const run of suspendedRuns) {
    if (run.status !== "suspended") continue;
    if (run.instanceId !== undefined) continue;
    if (!inputsMatch(run.inputs, newInputs)) continue;

    run.cancel("Superseded by new run with matching inputs");
    await runRepo.save(workflowId, run);
    cancelledRunIds.push(run.id);
  }

  return { cancelledRunIds };
}

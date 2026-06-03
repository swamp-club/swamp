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
import { createWorkflowId, createWorkflowRunId } from "./workflow_id.ts";
import { UserError } from "../errors.ts";

export interface SuspendedRunInfo {
  workflowName: string;
  workflowId: string;
  workflow: Workflow;
  run: WorkflowRun;
}

export async function resolveSuspendedRun(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
  workflowIdOrName: string,
  runId?: string,
): Promise<SuspendedRunInfo> {
  const workflow = await workflowRepo.findByName(workflowIdOrName) ??
    await workflowRepo.findById(createWorkflowId(workflowIdOrName));
  if (!workflow) {
    throw new UserError(`Workflow not found: ${workflowIdOrName}`);
  }

  if (runId) {
    const run = await runRepo.findById(
      workflow.id,
      createWorkflowRunId(runId),
    );
    if (!run) {
      throw new UserError(`Workflow run not found: ${runId}`);
    }
    if (run.status !== "suspended") {
      throw new UserError(
        `Run ${runId} is not suspended (status: ${run.status})`,
      );
    }
    return {
      workflowName: workflow.name,
      workflowId: workflow.id,
      workflow,
      run,
    };
  }

  const allRuns = await runRepo.findAllByWorkflowId(workflow.id);
  const suspendedRuns = allRuns.filter((r) => r.status === "suspended");

  if (suspendedRuns.length === 0) {
    throw new UserError(
      `No suspended runs found for workflow "${workflow.name}"`,
    );
  }
  if (suspendedRuns.length > 1) {
    const ids = suspendedRuns.map((r) => r.id).join("\n  ");
    throw new UserError(
      `Multiple suspended runs found for workflow "${workflow.name}":\n  ${ids}\n` +
        `Use --run <run-id> to specify which run to target.`,
    );
  }

  return {
    workflowName: workflow.name,
    workflowId: workflow.id,
    workflow,
    run: suspendedRuns[0],
  };
}

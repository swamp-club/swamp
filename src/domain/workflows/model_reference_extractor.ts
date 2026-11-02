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

/**
 * returns null if any reference contains a CEL expression, as a dynamic
 * reference cannot be statically resolved
 */

import type { Workflow } from "./workflow.ts";
import type { WorkflowRepository } from "./repositories.ts";
import { createWorkflowId } from "./workflow_id.ts";

export async function extractModelReferencesFromWorkflow(
  workflow: Workflow,
  workflowRepo: WorkflowRepository,
  visited?: Set<string>,
): Promise<string[] | null> {
  const seen = visited ?? new Set<string>();

  // Prevent infinite recursion from circular workflow references
  if (seen.has(workflow.id)) {
    return [];
  }
  seen.add(workflow.id);

  const references: string[] = [];

  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const task = step.task;
      if (!task) continue;

      const taskData = task.data;
      if (taskData.type === "model_method") {
        const refName = taskData.modelIdOrName ?? taskData.modelName;
        if (!refName) continue;

        if (refName.includes("${{")) {
          return null;
        }
        references.push(refName);
      } else if (taskData.type === "workflow") {
        if (taskData.workflowIdOrName.includes("${{")) {
          return null;
        }
        const nestedWorkflow =
          await workflowRepo.findByName(taskData.workflowIdOrName) ??
            await workflowRepo.findById(
              createWorkflowId(taskData.workflowIdOrName),
            );
        if (nestedWorkflow) {
          const nestedRefs = await extractModelReferencesFromWorkflow(
            nestedWorkflow,
            workflowRepo,
            seen,
          );
          if (nestedRefs === null) {
            return null;
          }
          references.push(...nestedRefs);
        }
      }
    }
  }

  return references;
}

/**
 * direct-type steps are skipped as their auto-created definitions carry only
 * what the YAML supplied; nested workflow steps are skipped as they build their
 * own context when they run
 */
export function extractStepDefinitionReferences(
  workflow: Workflow,
): string[] | null {
  const references: string[] = [];

  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const task = step.task;
      if (!task || task.isDirectExecution()) continue;

      const taskData = task.data;
      if (taskData.type !== "model_method") continue;
      if (!taskData.modelIdOrName) continue;
      if (taskData.modelIdOrName.includes("${{")) return null;

      references.push(taskData.modelIdOrName);
    }
  }

  return references;
}

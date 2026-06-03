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
 * Extracts model references from a workflow definition.
 *
 * Walks jobs → steps → tasks to collect all modelIdOrName values.
 * Recursively follows nested workflow tasks.
 * Returns null if any reference contains a CEL expression (dynamic
 * reference that cannot be statically resolved).
 */

import type { Workflow } from "./workflow.ts";
import type { WorkflowRepository } from "./repositories.ts";
import { createWorkflowId } from "./workflow_id.ts";

/**
 * Extracts all model references (modelIdOrName values) from a workflow.
 *
 * Recursively follows nested workflow tasks. If any model reference
 * contains a CEL expression (`${{`), returns null to signal that
 * the caller should fall back to a global lock.
 *
 * @param workflow - The workflow to extract references from
 * @param workflowRepo - Repository to look up nested workflows
 * @param visited - Set of already-visited workflow IDs (cycle prevention)
 * @returns Array of model ID/name strings, or null if dynamic references found
 */
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
        // Determine the reference name: modelIdOrName for existing, modelName for direct
        const refName = taskData.modelIdOrName ?? taskData.modelName;
        if (!refName) continue;

        // Check for dynamic CEL expressions
        if (refName.includes("${{")) {
          return null;
        }
        references.push(refName);
      } else if (taskData.type === "workflow") {
        // Check for dynamic CEL expressions in workflow reference
        if (taskData.workflowIdOrName.includes("${{")) {
          return null;
        }
        // Recursively extract from nested workflow
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

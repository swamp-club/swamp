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

import {
  MODEL_WORDS,
  type WordedText,
  wordedText,
} from "../behavior_wording.ts";
import {
  reservedRunTagRefusal,
  reservedTagRefusal,
} from "../models/data_writer.ts";
import type { Workflow } from "./workflow.ts";

export interface ReservedTagLookups {
  findDefinition?: (
    idOrName: string,
  ) => Promise<{ name: string; tags: Record<string, string> } | null>;
  findWorkflow?: (idOrName: string) => Promise<Workflow | null>;
}

export interface ReservedTagStep {
  jobName: string;
  stepName: string;
  workflow?: string;
}

export interface ReservedWorkflowTag {
  steps: ReservedTagStep[];
  refusal: WordedText;
}

/**
 * a name written as an expression is not followed, nor is a workflow already on
 * the path, so a cycle ends
 */
export async function reservedWorkflowTags(
  workflow: Workflow,
  lookups: ReservedTagLookups = {},
): Promise<ReservedWorkflowTag[]> {
  return await collect(workflow, lookups, new Set([workflow.id]), new Map());
}

async function collect(
  workflow: Workflow,
  lookups: ReservedTagLookups,
  ancestors: ReadonlySet<string>,
  definitions: Map<string, Promise<WordedText | undefined>>,
): Promise<ReservedWorkflowTag[]> {
  const found: ReservedWorkflowTag[] = [];
  const own = reservedRunTagRefusal({ tagOverrides: workflow.tags });
  if (own) found.push({ steps: [], refusal: own });
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const at = { jobName: job.name, stepName: step.name };
      const overrides = reservedRunTagRefusal({
        dataOutputOverrides: step.dataOutputOverrides,
      });
      if (overrides) found.push({ steps: [at], refusal: overrides });

      const task = step.task?.data;
      if (task?.type === "model_method" && lookups.findDefinition) {
        const ref = task.modelType ? task.modelName : task.modelIdOrName;
        if (!isLiteral(ref)) continue;
        let refusal = definitions.get(ref);
        if (!refusal) {
          refusal = definitionRefusal(ref, lookups.findDefinition);
          definitions.set(ref, refusal);
        }
        const definitionTag = await refusal;
        if (definitionTag) found.push({ steps: [at], refusal: definitionTag });
      } else if (task?.type === "workflow" && lookups.findWorkflow) {
        if (!isLiteral(task.workflowIdOrName)) continue;
        const child = await lookups.findWorkflow(task.workflowIdOrName)
          .catch(() => null);
        if (!child || ancestors.has(child.id)) continue;
        const nested = await collect(
          child,
          lookups,
          new Set([...ancestors, child.id]),
          definitions,
        );
        for (const inner of nested) {
          found.push({
            steps: [{ ...at, workflow: child.name }, ...inner.steps],
            refusal: inner.refusal,
          });
        }
      }
    }
  }
  return found;
}

async function definitionRefusal(
  ref: string,
  findDefinition: NonNullable<ReservedTagLookups["findDefinition"]>,
): Promise<WordedText | undefined> {
  const definition = await findDefinition(ref).catch(() => null);
  if (!definition) return undefined;
  return reservedTagRefusal(
    definition.tags,
    (w) => `the tags of ${w.noun} definition '${definition.name}'`,
  );
}

function isLiteral(ref: string | undefined): ref is string {
  return ref !== undefined && ref !== "" && !ref.includes("${{");
}

export async function reservedWorkflowRunTag(
  workflow: Workflow,
  runtimeTags: Record<string, string> | undefined,
  lookups: ReservedTagLookups,
): Promise<WordedText | undefined> {
  const runtime = reservedRunTagRefusal({ runtimeTags });
  if (runtime) return runtime;
  const [first] = await reservedWorkflowTags(workflow, lookups);
  return first && atSteps(first);
}

export function atSteps(found: ReservedWorkflowTag): WordedText {
  const prefix = found.steps.map((step) =>
    `Step '${step.stepName}' in job '${step.jobName}'${
      step.workflow ? ` (workflow '${step.workflow}')` : ""
    }: `
  ).join("");
  return wordedText((w) =>
    prefix + (w === MODEL_WORDS ? found.refusal.modelText : found.refusal.text)
  );
}

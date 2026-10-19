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

/**
 * How {@link reservedWorkflowTags} finds what a step names. Each lookup is
 * optional: without it, steps of that kind are not followed. A lookup that
 * throws counts as not found; the step that uses it reports the problem when
 * it runs.
 */
export interface ReservedTagLookups {
  /** The stored definition a step names, by name or id. */
  findDefinition?: (
    idOrName: string,
  ) => Promise<{ name: string; tags: Record<string, string> } | null>;
  /** The workflow a step runs, by name or id. */
  findWorkflow?: (idOrName: string) => Promise<Workflow | null>;
}

/** One step on the way to a reserved tag, outermost first. */
export interface ReservedTagStep {
  jobName: string;
  stepName: string;
  /** Set when the step runs a nested workflow the key is found in. */
  workflow?: string;
}

/**
 * A reserved tag key a workflow supplies (swamp-club#3635). Every method run
 * refuses one; a workflow run, a resume and `workflow validate` find them
 * before any step runs.
 */
export interface ReservedWorkflowTag {
  /** The steps that lead to the key; empty for the workflow's own tags. */
  steps: ReservedTagStep[];
  refusal: WordedText;
}

/**
 * The reserved tag keys a workflow supplies: in its own tags, every step's
 * data output overrides, the stored definition each step names (its
 * `modelIdOrName`, or the `modelName` a direct type execution adopts), and,
 * recursively, each nested workflow a step runs. A name written as an
 * expression is not followed, nor is a workflow already on the path, so a
 * cycle ends. Spec default tags are left to the step's own validation.
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

/** Whether a step names what it runs literally, not with an expression. */
function isLiteral(ref: string | undefined): ref is string {
  return ref !== undefined && ref !== "" && !ref.includes("${{");
}

/**
 * The first reserved tag key a workflow run or resume would refuse, found
 * before any step runs: in `--tag`, then anywhere
 * {@link reservedWorkflowTags} looks. A step that names what it runs with an
 * expression, and each type's spec defaults, are left to the refusal each
 * method run makes when it starts.
 *
 * @returns The refusal, prefixed with the steps it is about, or undefined
 */
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

/** A finding's refusal, prefixed with each step on the way to it. */
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

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

import { type WordedText, wordedText } from "../behavior_wording.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import {
  reservedRunTagRefusal,
  reservedTagRefusal,
} from "../models/data_writer.ts";
import { findDefinitionByIdOrName } from "../models/model_lookup.ts";
import type { Workflow } from "./workflow.ts";

/**
 * A reserved tag key a workflow supplies (swamp-club#3635): in its own tags,
 * or in a step's data output override. Every method run refuses one; a
 * workflow run and `workflow validate` find them all before any step runs.
 */
export interface ReservedWorkflowTag {
  /** The step whose override holds the key; absent for the workflow's tags. */
  step?: { jobName: string; stepName: string };
  refusal: WordedText;
}

/**
 * The reserved tag keys in the tags the workflow itself declares: its own
 * tags and every step's data output overrides, one finding per source that
 * holds one.
 */
export function reservedWorkflowTags(
  workflow: Workflow,
): ReservedWorkflowTag[] {
  const found: ReservedWorkflowTag[] = [];
  const own = reservedRunTagRefusal({ tagOverrides: workflow.tags });
  if (own) found.push({ refusal: own });
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const refusal = reservedRunTagRefusal({
        dataOutputOverrides: step.dataOutputOverrides,
      });
      if (refusal) {
        found.push({
          step: { jobName: job.name, stepName: step.name },
          refusal,
        });
      }
    }
  }
  return found;
}

/**
 * The first reserved tag key a workflow run would refuse, found before any
 * step runs: in `--tag`, the workflow's own tags, a step's data output
 * override, or the stored definition a step names (by a literal name or id).
 * A step that names its definition with an expression, or executes a type
 * directly, is left to the refusal each method run makes when it starts, as
 * are the default tags of each type's specs.
 *
 * @returns The refusal, prefixed with the step it is about, or undefined
 */
export async function reservedWorkflowRunTag(
  workflow: Workflow,
  runtimeTags: Record<string, string> | undefined,
  definitionRepo: DefinitionRepository,
): Promise<WordedText | undefined> {
  const runtime = reservedRunTagRefusal({ runtimeTags });
  if (runtime) return runtime;
  const [declared] = reservedWorkflowTags(workflow);
  if (declared) return atStep(declared);

  const checked = new Set<string>();
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const task = step.task?.data;
      if (task?.type !== "model_method" || !task.modelIdOrName) continue;
      const ref = task.modelIdOrName;
      if (ref.includes("${{") || checked.has(ref)) continue;
      checked.add(ref);
      const lookup = await findDefinitionByIdOrName(definitionRepo, ref);
      if (!lookup) continue;
      const name = lookup.definition.name;
      const refusal = reservedTagRefusal(
        lookup.definition.tags,
        (w) => `the tags of ${w.noun} definition '${name}'`,
      );
      if (refusal) {
        return atStep({
          step: { jobName: job.name, stepName: step.name },
          refusal,
        });
      }
    }
  }
  return undefined;
}

/** A finding's refusal, prefixed with the step it is about when it has one. */
export function atStep(found: ReservedWorkflowTag): WordedText {
  const step = found.step;
  if (!step) return found.refusal;
  return wordedText((w) =>
    `Step '${step.stepName}' in job '${step.jobName}': ${
      pick(found.refusal, w)
    }`
  );
}

/** The spelling of `text` that matches `w`. */
function pick(text: WordedText, w: { noun: string }): string {
  return w.noun === "model" ? text.modelText : text.text;
}

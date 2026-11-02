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
 * run inputs are write-once: a new key may be added, an existing key keeps its
 * value so later steps never act on a value earlier steps did not see
 */

import { UserError } from "../errors.ts";
import { quoteShellWord } from "../shell_word.ts";
import { canonicalJson } from "../expressions/expression_references.ts";
import { deepMerge } from "../inputs/input_merge.ts";
import { suspendedWayOut } from "./resume_reset.ts";
import type { Workflow } from "./workflow.ts";
import type { WorkflowRun } from "./workflow_run.ts";

export function checkResumeInputOverrides(
  workflow: Workflow,
  run: WorkflowRun,
  resumeInputs: Record<string, unknown>,
): void {
  const changed = changedKeys(run.inputs, resumeInputs);
  const unrecorded = unrecordedKeys(run);
  if (changed.length === 0 && unrecorded.length === 0) return;
  throw new UserError(
    refusalMessage(workflow, run, changed, unrecorded),
    "resume_input_immutable",
  );
}

function changedKeys(
  stored: Readonly<Record<string, unknown>>,
  resumeInputs: Record<string, unknown>,
): string[] {
  const merged = deepMerge({ ...stored }, resumeInputs);
  return Object.keys(resumeInputs).filter((key) =>
    Object.hasOwn(stored, key) &&
    canonicalJson(merged[key]) !== canonicalJson(stored[key])
  );
}

/**
 * a key listed as supplied but with no recorded value cannot be compared, so
 * every resume is refused; the way out is a new run
 */
function unrecordedKeys(
  run: WorkflowRun,
): string[] {
  return run.resumeInputs.filter((key) => !Object.hasOwn(run.inputs, key));
}

/**
 * names keys, never values, since inputs may hold secrets; the run id comes
 * first because serve cuts an error at 512 characters
 */
function refusalMessage(
  workflow: Workflow,
  run: WorkflowRun,
  changed: readonly string[],
  unrecorded: readonly string[],
): string {
  const quoted = (keys: readonly string[]) =>
    keys.map((k) => `"${k}"`).join(", ");
  const name = quoteShellWord(workflow.name);
  const newRun =
    `a new run with all its inputs (swamp workflow run ${name} --input ...)`;
  const wayOut = run.status === "suspended"
    // left suspended, the run would wait for a resume that cannot come; a run
    // serve started is cancelled through serve
    ? `${suspendedWayOut(workflow, run)} Then start ${newRun}.`
    : `Start ${newRun}.`;
  const parts = [
    ...(changed.length === 1
      ? [`input ${quoted(changed)} already has a value`]
      : changed.length > 1
      ? [`inputs ${quoted(changed)} already have values`]
      : []),
    ...(unrecorded.length > 0
      ? [
        `${unrecorded.length === 1 ? "input" : "inputs"} ${
          quoted(unrecorded)
        } ${
          unrecorded.length === 1 ? "was" : "were"
        } supplied at an earlier resume, which recorded no value to compare with`,
      ]
      : []),
  ];
  return `Run ${run.id} is unchanged: ${
    parts.join("; ")
  }, and a value a run has cannot change. ${wayOut}`;
}

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
 * Whether a resume's `--input` may change the run's inputs (swamp-club#3583).
 *
 * A run's inputs are write-once. A key the run does not have may be added:
 * a value that did not exist at start, such as the vault key name of a
 * credential issued during a gate, arrives this way. A key the run has keeps
 * its value: a step that ran read it as it was, and the steps after it must
 * not act on a value nothing before them saw. The check reads the run record
 * and the supplied keys, nothing else: not the workflow, not the behavior
 * definitions, not the evaluated caches, not what any step read. A finished
 * step that tested for a key the run did not have saw its absence, and the
 * key may still be added; the design accepts that limit and documents the
 * pattern that makes a late input safe (design/enablers/input-pinning.md,
 * Late inputs).
 */

import { UserError } from "../errors.ts";
import { quoteShellWord } from "../shell_word.ts";
import { canonicalJson } from "../expressions/expression_references.ts";
import { deepMerge } from "../inputs/input_merge.ts";
import { suspendedWayOut } from "./resume_reset.ts";
import type { Workflow } from "./workflow.ts";
import type { WorkflowRun } from "./workflow_run.ts";

/**
 * Refuses a resume whose inputs change a value the run has. Throws a
 * UserError coded `resume_input_immutable` before anything changes; returns
 * when every supplied key is new to the run or carries the value it has.
 */
export function checkResumeInputOverrides(
  workflow: Workflow,
  run: WorkflowRun,
  resumeInputs: Record<string, unknown>,
): void {
  const changed = changedKeys(run.inputs, resumeInputs);
  const unrecorded = unrecordedKeys(run, resumeInputs);
  if (changed.length === 0 && unrecorded.length === 0) return;
  throw new UserError(
    refusalMessage(workflow, run, changed, unrecorded),
    "resume_input_immutable",
  );
}

/**
 * The supplied top-level keys the run has whose value, merged over the
 * stored inputs, differs from the stored one. A key the run does not have
 * is not a change: it is added.
 */
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
 * The supplied keys an earlier resume supplied without recording a value: a
 * run resumed by an older swamp listed the key names but kept its inputs as
 * started. A resume that died between saving the key names and recording the
 * merged inputs looks the same. The run has such a key, with a value nothing
 * can compare, so it cannot take another: refusing is the safe side, and the
 * way out is a new run.
 */
function unrecordedKeys(
  run: WorkflowRun,
  resumeInputs: Record<string, unknown>,
): string[] {
  return Object.keys(resumeInputs).filter((key) =>
    !Object.hasOwn(run.inputs, key) && run.resumeInputs.includes(key)
  );
}

/**
 * Names each refused key, never a value: inputs may hold secrets. A
 * suspended run is left suspended, so the way out names the cancel command
 * first; a failed run can only be started again. The run id comes first:
 * serve cuts an error at 512 characters.
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
    // Left suspended, the run would wait for a resume that cannot come. A
    // run serve started is cancelled through serve.
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

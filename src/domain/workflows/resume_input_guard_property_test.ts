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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { UserError } from "../errors.ts";
import { canonicalJson } from "../expressions/expression_references.ts";
import { deepMerge } from "../inputs/input_merge.ts";
import { Job } from "./job.ts";
import { checkResumeInputOverrides } from "./resume_input_guard.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import { WorkflowRun } from "./workflow_run.ts";

const workflow = Workflow.create({
  name: "pinned",
  jobs: [
    Job.create({
      name: "main",
      steps: [
        Step.create({
          name: "gate",
          task: StepTask.manualApproval("Proceed?"),
        }),
      ],
    }),
  ],
});

/** A suspended run with `inputs` recorded. */
function suspendedRun(inputs: Record<string, unknown>): WorkflowRun {
  const created = WorkflowRun.create(workflow);
  created.start();
  const data = created.toData();
  data.status = "suspended";
  data.inputs = inputs;
  return WorkflowRun.fromData(data);
}

const key = fc.constantFrom("a", "b", "c", "d", "nested");
const scalar = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
);
const value = fc.oneof(
  scalar,
  fc.array(scalar, { maxLength: 3 }),
  fc.dictionary(fc.constantFrom("x", "y"), scalar, { maxKeys: 2 }),
);
const inputs = fc.dictionary(key, value, { maxKeys: 5 });

Deno.test("checkResumeInputOverrides: refuses exactly when a key the run has would change, and never mutates the run", () => {
  fc.assert(
    fc.property(inputs, inputs, (stored, supplied) => {
      const run = suspendedRun(structuredClone(stored));
      const before = JSON.stringify(run.toData());
      const merged = deepMerge(
        structuredClone(stored),
        structuredClone(supplied),
      );
      const changed = Object.keys(supplied).filter((k) =>
        Object.hasOwn(stored, k) &&
        canonicalJson(merged[k]) !== canonicalJson(stored[k])
      );
      let refused: UserError | undefined;
      try {
        checkResumeInputOverrides(workflow, run, supplied);
      } catch (error) {
        assert(error instanceof UserError);
        refused = error;
      }
      assertEquals(refused !== undefined, changed.length > 0);
      assertEquals(JSON.stringify(run.toData()), before);
      if (refused) {
        assertEquals(refused.code, "resume_input_immutable");
        for (const k of changed) assert(refused.message.includes(`"${k}"`));
        // Keys only added are not named.
        for (const k of Object.keys(supplied)) {
          if (!Object.hasOwn(stored, k)) {
            assertEquals(refused.message.includes(`"${k}"`), false);
          }
        }
      }
    }),
  );
});

Deno.test("checkResumeInputOverrides: re-supplying what the run has is always accepted", () => {
  fc.assert(
    fc.property(inputs, (stored) => {
      const run = suspendedRun(structuredClone(stored));
      checkResumeInputOverrides(workflow, run, structuredClone(stored));
    }),
  );
});

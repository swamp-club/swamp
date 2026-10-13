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

// The behavior spelling of a step task is an exact synonym of the
// model_method spelling (swamp-club#3334): it parses, and is written back,
// identically, and a task mixing the two is always refused.

import { assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { normalizeBehaviorTask, StepTaskSchema } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import { BEHAVIOR_STEP_TASK_FIELDS } from "../terminology/behavior_aliases.ts";

const MODEL_TO_BEHAVIOR: Record<string, string> = Object.fromEntries(
  Object.entries(BEHAVIOR_STEP_TASK_FIELDS).map(([b, m]) => [m, b]),
);

const arbName = fc.oneof(
  fc.string({ minLength: 1, maxLength: 12 }),
  fc.constantFrom("${{ inputs.name }}", "web-${{ self.item }}", "@acme/x"),
);

const arbArgs = fc.option(
  fc.oneof(
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 8 }),
      fc.oneof(
        fc.jsonValue({ maxDepth: 2 }),
        fc.constant("${{ inputs.value }}"),
      ),
      { maxKeys: 4 },
    ),
    fc.constant("${{ inputs.args }}"),
  ),
  { nil: undefined },
);

/** A valid model_method task as entries, in an arbitrary key order. */
const arbModelEntries: fc.Arbitrary<[string, unknown][]> = fc.oneof(
  fc.record({ ref: arbName, method: arbName, inputs: arbArgs }).map((
    { ref, method, inputs },
  ) =>
    [
      ["modelIdOrName", ref],
      ["methodName", method],
      ...(inputs === undefined ? [] : [["inputs", inputs]]),
    ] as [string, unknown][]
  ),
  fc.record({
    type: arbName,
    name: arbName,
    method: arbName,
    inputs: arbArgs,
    globalArgs: arbArgs,
  }).map(({ type, name, method, inputs, globalArgs }) =>
    [
      ["modelType", type],
      ["modelName", name],
      ["methodName", method],
      ...(inputs === undefined ? [] : [["inputs", inputs]]),
      ...(globalArgs === undefined ? [] : [["globalArgs", globalArgs]]),
    ] as [string, unknown][]
  ),
).chain((entries) =>
  fc.shuffledSubarray(entries, {
    minLength: entries.length,
    maxLength: entries.length,
  })
);

function modelTask(entries: [string, unknown][]): Record<string, unknown> {
  return Object.fromEntries([["type", "model_method"], ...entries]);
}

function behaviorTask(entries: [string, unknown][]): Record<string, unknown> {
  return Object.fromEntries([
    ["type", "behavior"],
    ...entries.map(([k, v]) => [MODEL_TO_BEHAVIOR[k] ?? k, v]),
  ]);
}

function workflowYaml(task: Record<string, unknown>): string {
  return stringifyYaml({
    id: "00000000-0000-4000-8000-000000000001",
    name: "spelled",
    jobs: [{ name: "main", steps: [{ name: "s", task }] }],
  });
}

function written(yaml: string): string {
  const data = Workflow.fromData(parseYaml(yaml) as never).toData();
  return stringifyYaml(JSON.parse(JSON.stringify(data)));
}

Deno.test("StepTaskSchema property: the behavior spelling parses to the same task", () => {
  fc.assert(
    fc.property(arbModelEntries, (entries) => {
      const model = StepTaskSchema.parse(modelTask(entries));
      const behavior = StepTaskSchema.parse(behaviorTask(entries));
      assertEquals(behavior, model);
      assertEquals(JSON.stringify(behavior), JSON.stringify(model));
    }),
    { numRuns: 300 },
  );
});

Deno.test("Workflow property: a behavior-spelled file is written byte-identically to the model one", () => {
  fc.assert(
    fc.property(arbModelEntries, (entries) => {
      assertEquals(
        written(workflowYaml(behaviorTask(entries))),
        written(workflowYaml(modelTask(entries))),
      );
    }),
    { numRuns: 200 },
  );
});

Deno.test("normalizeBehaviorTask property: a behavior task mixing model keys is refused; a model_method task ignores stray behavior keys", () => {
  const modelKeys = Object.values(BEHAVIOR_STEP_TASK_FIELDS);
  const behaviorKeys = Object.keys(BEHAVIOR_STEP_TASK_FIELDS);
  const arbValue = fc.oneof(fc.string(), fc.integer(), fc.constant(null));
  fc.assert(
    fc.property(
      arbModelEntries,
      fc.subarray(modelKeys, { minLength: 1 }),
      fc.subarray(behaviorKeys, { minLength: 1 }),
      arbValue,
      (entries, strayModel, strayBehavior, value) => {
        const behavior = {
          ...behaviorTask(entries),
          ...Object.fromEntries(strayModel.map((k) => [k, value])),
        };
        assertThrows(() => normalizeBehaviorTask(behavior));
        assertThrows(() => StepTaskSchema.parse(behavior));
        const model = {
          ...modelTask(entries),
          ...Object.fromEntries(strayBehavior.map((k) => [k, value])),
        };
        // A model_method task keeps dropping undeclared keys, as it always
        // has: a stray behavior key changes nothing.
        assertEquals(
          StepTaskSchema.parse(model),
          StepTaskSchema.parse(modelTask(entries)),
        );
      },
    ),
    { numRuns: 300 },
  );
});

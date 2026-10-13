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

// The behavior spelling of a workflow step task (swamp-club#3334).

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import {
  BehaviorTaskDocSchema,
  ModelMethodTaskRawSchema,
  normalizeBehaviorTask,
  StepTask,
  StepTaskSchema,
} from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import {
  BEHAVIOR_STEP_TASK_FIELDS,
  BEHAVIOR_STEP_TASK_TYPE,
  MODEL_STEP_TASK_TYPE,
} from "../terminology/behavior_aliases.ts";

Deno.test("normalizeBehaviorTask: rewrites an existing-definition task, keeping key order", () => {
  const out = normalizeBehaviorTask({
    type: "behavior",
    behavior: "my-model",
    methodName: "run",
    inputs: { a: 1 },
  });
  assertEquals(
    JSON.stringify(out),
    JSON.stringify({
      type: "model_method",
      modelIdOrName: "my-model",
      methodName: "run",
      inputs: { a: 1 },
    }),
  );
});

Deno.test("normalizeBehaviorTask: rewrites a direct-type task with globalArgs", () => {
  const out = normalizeBehaviorTask({
    type: "behavior",
    behaviorType: "@acme/thing",
    behaviorName: "t-${{ inputs.env }}",
    methodName: "create",
    globalArgs: { region: "us-east-1" },
  });
  assertEquals(
    JSON.stringify(out),
    JSON.stringify({
      type: "model_method",
      modelType: "@acme/thing",
      modelName: "t-${{ inputs.env }}",
      methodName: "create",
      globalArgs: { region: "us-east-1" },
    }),
  );
});

Deno.test("normalizeBehaviorTask: model_method and other step types pass through unchanged", () => {
  const values: unknown[] = [
    { type: "model_method", modelIdOrName: "m", methodName: "run" },
    { type: "workflow", workflowIdOrName: "w" },
    { type: "manual_approval", prompt: "ok?" },
    { type: "assert", expr: "true", message: "m" },
    { type: "wait_for_signal", timeout: 1, schema: { type: "object" } },
    // A behavior key on another step type is left to the schema, as any
    // unknown key is.
    { type: "workflow", workflowIdOrName: "w", behavior: "x" },
    { type: "behaviour", behavior: "m", methodName: "run" },
    null,
    "behavior",
    ["behavior"],
    42,
  ];
  for (const value of values) {
    assertStrictEquals(normalizeBehaviorTask(value), value);
  }
});

Deno.test("normalizeBehaviorTask: a task mixing the two spellings is refused", () => {
  const mixes: [Record<string, unknown>, string][] = [
    [
      { type: "behavior", behavior: "m", modelIdOrName: "m", methodName: "r" },
      "modelIdOrName",
    ],
    [
      { type: "behavior", modelIdOrName: "m", methodName: "r" },
      "modelIdOrName",
    ],
    [{
      type: "behavior",
      behaviorType: "t",
      behaviorName: "n",
      modelType: "t",
      methodName: "r",
    }, "modelType"],
    [
      { type: "behavior", behavior: "m", modelName: "n", methodName: "r" },
      "modelName",
    ],
  ];
  for (const [task, key] of mixes) {
    const error = assertThrows(() => normalizeBehaviorTask(task), Error);
    assert(
      error.message.includes(key),
      `${JSON.stringify(task)}: ${error.message}`,
    );
    // And through the schema every consumer parses with.
    assertThrows(() => StepTaskSchema.parse(task));
  }
});

Deno.test("normalizeBehaviorTask: a model_method task with a stray behavior key parses exactly as before", () => {
  // The model_method schema has always dropped undeclared keys, so an
  // existing file with a leftover behavior field must keep working.
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      {
        type: "model_method",
        modelIdOrName: "m",
        behavior: "x",
        methodName: "r",
      },
      { type: "model_method", modelIdOrName: "m", methodName: "r" },
    ],
    [
      {
        type: "model_method",
        modelType: "t",
        modelName: "n",
        behaviorType: "u",
        methodName: "r",
      },
      { type: "model_method", modelType: "t", modelName: "n", methodName: "r" },
    ],
    [
      {
        type: "model_method",
        modelIdOrName: "m",
        behaviorName: "n",
        methodName: "r",
      },
      { type: "model_method", modelIdOrName: "m", methodName: "r" },
    ],
  ];
  for (const [withStray, without] of cases) {
    assertEquals(normalizeBehaviorTask(withStray), withStray);
    assertEquals(
      StepTaskSchema.parse(withStray),
      StepTaskSchema.parse(without),
    );
  }
});

Deno.test("normalizeBehaviorTask: reference errors use the behavior spelling", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{
      type: "behavior",
      behavior: "m",
      behaviorType: "t",
      behaviorName: "n",
      methodName: "r",
    }, "Step task has both behavior and behaviorType"],
    [
      { type: "behavior", methodName: "r" },
      "Step task requires either behavior or behaviorType + behaviorName.",
    ],
    [
      { type: "behavior", behaviorType: "t", methodName: "r" },
      "behaviorType requires behaviorName",
    ],
    [
      {
        type: "behavior",
        behavior: "m",
        methodName: "r",
        globalArgs: { a: 1 },
      },
      "globalArgs is only valid with direct type execution (behaviorType + behaviorName)",
    ],
  ];
  for (const [task, message] of cases) {
    const error = assertThrows(() => StepTaskSchema.parse(task), Error);
    assert(error.message.includes(message), error.message);
    assert(!error.message.includes("modelIdOrName"), error.message);
  }
});

Deno.test("StepTaskSchema: a behavior-spelled task parses to the model_method task", () => {
  const behavior = StepTaskSchema.parse({
    type: "behavior",
    behavior: "my-model",
    methodName: "run",
  });
  const model = StepTaskSchema.parse({
    type: "model_method",
    modelIdOrName: "my-model",
    methodName: "run",
  });
  assertEquals(behavior, model);
  const task = StepTask.fromData(
    { type: "behavior", behavior: "m", methodName: "run" } as never,
  );
  assert(task.isModelMethod());
  assertEquals(task.data.type, "model_method");
});

Deno.test("Workflow: a behavior-spelled file is written back in the model form", () => {
  const yaml = `id: 00000000-0000-4000-8000-000000000001
name: spelled
jobs:
  - name: main
    steps:
      - name: a
        task:
          type: behavior
          behavior: my-model
          methodName: run
      - name: b
        task:
          type: behavior
          behaviorType: "@acme/thing"
          behaviorName: thing
          methodName: create
          globalArgs:
            region: us-east-1
`;
  const written = stringifyYaml(
    JSON.parse(
      JSON.stringify(Workflow.fromData(parseYaml(yaml) as never).toData()),
    ),
  );
  assert(!written.includes("behavior"), written);
  assert(written.includes("type: model_method"), written);
  assert(written.includes("modelIdOrName: my-model"), written);
  assert(written.includes("modelType: '@acme/thing'"), written);
  assert(written.includes("modelName: thing"), written);
});

Deno.test("BehaviorTaskDocSchema: has a field for each model_method field, in order", () => {
  const modelKeys = Object.keys(ModelMethodTaskRawSchema.shape);
  const behaviorKeys = Object.keys(BehaviorTaskDocSchema.shape);
  assertEquals(
    behaviorKeys.map((key) => BEHAVIOR_STEP_TASK_FIELDS[key] ?? key),
    modelKeys,
  );
  const docShape = BehaviorTaskDocSchema.shape as Record<string, z.ZodType>;
  const modelShape = ModelMethodTaskRawSchema.shape as Record<
    string,
    z.ZodType
  >;
  for (const key of behaviorKeys) {
    const modelKey = BEHAVIOR_STEP_TASK_FIELDS[key] ?? key;
    const doc = z.toJSONSchema(docShape[key]) as Record<string, unknown>;
    const model = z.toJSONSchema(modelShape[modelKey]) as Record<
      string,
      unknown
    >;
    if (key === "type") {
      assertEquals(doc.const, BEHAVIOR_STEP_TASK_TYPE);
      assertEquals(model.const, MODEL_STEP_TASK_TYPE);
    } else {
      assertEquals(doc, model, key);
    }
  }
  assertEquals(
    BehaviorTaskDocSchema.shape.behavior.isOptional(),
    ModelMethodTaskRawSchema.shape.modelIdOrName.isOptional(),
  );
});

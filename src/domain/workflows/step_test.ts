// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals } from "@std/assert";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";

Deno.test("Step.create creates step with minimal props", () => {
  const task = StepTask.model("test-model", "run");
  const step = Step.create({
    name: "say-hello",
    task,
  });

  assertEquals(step.name, "say-hello");
  assertEquals(step.description, undefined);
  assertEquals(step.task.equals(task), true);
  assertEquals(step.dependsOn.length, 0);
  assertEquals(step.weight, 0);
});

Deno.test("Step.create creates step with all props", () => {
  const task = StepTask.model("my-model", "run");
  const step = Step.create({
    name: "run-model",
    description: "Runs the model",
    task,
    dependsOn: [
      { step: "prepare", condition: TriggerCondition.succeeded() },
    ],
    weight: 10,
  });

  assertEquals(step.name, "run-model");
  assertEquals(step.description, "Runs the model");
  assertEquals(step.task.equals(task), true);
  assertEquals(step.dependsOn.length, 1);
  assertEquals(step.dependsOn[0].step, "prepare");
  assertEquals(step.weight, 10);
});

Deno.test("Step.getDependencyNames returns step names", () => {
  const task = StepTask.model("test-model", "run");
  const step = Step.create({
    name: "final",
    task,
    dependsOn: [
      { step: "step1", condition: TriggerCondition.succeeded() },
      { step: "step2", condition: TriggerCondition.succeeded() },
    ],
  });

  assertEquals(step.getDependencyNames().sort(), ["step1", "step2"]);
});

Deno.test("Step.fromData reconstructs step correctly", () => {
  const data = {
    name: "test-step",
    description: "A test step",
    task: {
      type: "model_method" as const,
      modelIdOrName: "test-model",
      methodName: "run",
    },
    dependsOn: [
      {
        step: "prev",
        condition: { type: "always" as const },
      },
    ],
    weight: 5,
  };

  const step = Step.fromData(data);
  assertEquals(step.name, "test-step");
  assertEquals(step.description, "A test step");
  assertEquals(step.task.isModelMethod(), true);
  assertEquals(step.dependsOn.length, 1);
  assertEquals(step.dependsOn[0].step, "prev");
  assertEquals(step.weight, 5);
});

Deno.test("Step.toData returns correct structure", () => {
  const task = StepTask.model("test-model", "run");
  const step = Step.create({
    name: "say-hello",
    description: "Says hello",
    task,
    dependsOn: [
      { step: "prepare", condition: TriggerCondition.always() },
    ],
    weight: 3,
  });

  const data = step.toData();
  assertEquals(data.name, "say-hello");
  assertEquals(data.description, "Says hello");
  assertEquals(data.task.type, "model_method");
  assertEquals(data.dependsOn.length, 1);
  assertEquals(data.dependsOn[0].step, "prepare");
  assertEquals(data.dependsOn[0].condition.type, "always");
  assertEquals(data.weight, 3);
});

Deno.test("Step.fromData and toData roundtrip correctly", () => {
  const original = Step.create({
    name: "complex-step",
    description: "A complex step",
    task: StepTask.model("model", "method"),
    dependsOn: [
      { step: "step1", condition: TriggerCondition.succeeded() },
      {
        step: "step2",
        condition: TriggerCondition.or([
          TriggerCondition.failed(),
          TriggerCondition.skipped(),
        ]),
      },
    ],
    weight: 100,
  });

  const data = original.toData();
  const restored = Step.fromData(data);

  assertEquals(restored.name, original.name);
  assertEquals(restored.description, original.description);
  assertEquals(restored.task.equals(original.task), true);
  assertEquals(restored.dependsOn.length, original.dependsOn.length);
  assertEquals(restored.weight, original.weight);
});

// allowFailure field tests

Deno.test("Step.create defaults allowFailure to false", () => {
  const task = StepTask.model("test-model", "run");
  const step = Step.create({
    name: "basic-step",
    task,
  });

  assertEquals(step.allowFailure, false);
});

Deno.test("Step.create with allowFailure true", () => {
  const task = StepTask.model("test-model", "run");
  const step = Step.create({
    name: "optional-step",
    task,
    allowFailure: true,
  });

  assertEquals(step.allowFailure, true);
});

Deno.test("Step.fromData reconstructs step with allowFailure", () => {
  const data = {
    name: "optional-step",
    task: {
      type: "model_method" as const,
      modelIdOrName: "test-model",
      methodName: "run",
    },
    dependsOn: [],
    weight: 0,
    allowFailure: true,
  };

  const step = Step.fromData(data);
  assertEquals(step.allowFailure, true);
});

Deno.test("Step.fromData defaults allowFailure to false when missing", () => {
  const data = {
    name: "basic-step",
    task: {
      type: "model_method" as const,
      modelIdOrName: "test-model",
      methodName: "run",
    },
    dependsOn: [],
    weight: 0,
  };

  const step = Step.fromData(data);
  assertEquals(step.allowFailure, false);
});

Deno.test("Step.toData includes allowFailure", () => {
  const step = Step.create({
    name: "optional-step",
    task: StepTask.model("test-model", "run"),
    allowFailure: true,
  });

  const data = step.toData();
  assertEquals(data.allowFailure, true);
});

Deno.test("Step.fromData and toData roundtrip with allowFailure", () => {
  const original = Step.create({
    name: "optional-step",
    task: StepTask.model("test-model", "run"),
    allowFailure: true,
  });

  const data = original.toData();
  const restored = Step.fromData(data);

  assertEquals(restored.allowFailure, original.allowFailure);
});

// driver field tests

Deno.test("Step.create defaults driver to undefined", () => {
  const task = StepTask.model("test-model", "run");
  const step = Step.create({ name: "basic", task });
  assertEquals(step.driver, undefined);
  assertEquals(step.driverConfig, undefined);
});

Deno.test("Step.create uses provided driver and driverConfig", () => {
  const task = StepTask.model("test-model", "run");
  const step = Step.create({
    name: "isolated",
    task,
    driver: "docker",
    driverConfig: { image: "node:18" },
  });
  assertEquals(step.driver, "docker");
  assertEquals(step.driverConfig, { image: "node:18" });
});

Deno.test("Step.toData includes driver and driverConfig", () => {
  const step = Step.create({
    name: "isolated",
    task: StepTask.model("test-model", "run"),
    driver: "docker",
    driverConfig: { timeout: 30 },
  });
  const data = step.toData();
  assertEquals(data.driver, "docker");
  assertEquals(data.driverConfig, { timeout: 30 });
});

Deno.test("Step.fromData and toData roundtrip with driver", () => {
  const original = Step.create({
    name: "isolated",
    task: StepTask.model("test-model", "run"),
    driver: "raw",
  });
  const data = original.toData();
  const restored = Step.fromData(data);
  assertEquals(restored.driver, "raw");
  assertEquals(restored.driverConfig, undefined);
});

// forEach field tests

Deno.test("Step.create creates step with forEach", () => {
  const task = StepTask.model("echo-model", "write");
  const step = Step.create({
    name: "deploy-${{self.env}}",
    task,
    forEach: {
      item: "env",
      in: "${{ inputs.environments }}",
    },
  });

  assertEquals(step.forEach !== undefined, true);
  assertEquals(step.forEach?.item, "env");
  assertEquals(step.forEach?.in, "${{ inputs.environments }}");
});

Deno.test("Step.create creates step without forEach", () => {
  const task = StepTask.model("test-model", "run");
  const step = Step.create({
    name: "simple-step",
    task,
  });

  assertEquals(step.forEach, undefined);
});

Deno.test("Step.fromData reconstructs step with forEach", () => {
  const data = {
    name: "process-${{self.item}}",
    task: {
      type: "model_method" as const,
      modelIdOrName: "processor",
      methodName: "run",
    },
    forEach: {
      item: "item",
      in: "${{ inputs.items }}",
    },
    dependsOn: [],
    weight: 0,
  };

  const step = Step.fromData(data);
  assertEquals(step.forEach !== undefined, true);
  assertEquals(step.forEach?.item, "item");
  assertEquals(step.forEach?.in, "${{ inputs.items }}");
});

Deno.test("Step.toData includes forEach in output", () => {
  const step = Step.create({
    name: "tag-${{self.tag.key}}",
    task: StepTask.model("tagger", "apply"),
    forEach: {
      item: "tag",
      in: "${{ inputs.tags }}",
    },
  });

  const data = step.toData();
  assertEquals(data.forEach !== undefined, true);
  assertEquals(data.forEach?.item, "tag");
  assertEquals(data.forEach?.in, "${{ inputs.tags }}");
});

Deno.test("Step.fromData and toData roundtrip with forEach", () => {
  const original = Step.create({
    name: "deploy-${{self.region}}",
    description: "Deploy to region",
    task: StepTask.model("deployer", "deploy"),
    forEach: {
      item: "region",
      in: "${{ inputs.regions }}",
    },
    weight: 5,
  });

  const data = original.toData();
  const restored = Step.fromData(data);

  assertEquals(restored.name, original.name);
  assertEquals(restored.forEach?.item, original.forEach?.item);
  assertEquals(restored.forEach?.in, original.forEach?.in);
});

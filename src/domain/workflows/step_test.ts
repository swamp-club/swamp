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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { Step, type StepInput, StepSchema } from "./step.ts";
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

// Removed driver field tests (see design/remote-execution.md)

Deno.test("StepSchema rejects removed driver field with actionable error", () => {
  const error = assertThrows(
    () =>
      Step.fromData({
        name: "isolated",
        task: {
          type: "model_method",
          modelIdOrName: "test-model",
          methodName: "run",
        },
        driver: "docker",
      } as unknown as StepInput),
    Error,
  );
  assertStringIncludes(
    error.message,
    "The 'driver' field has been removed",
  );
  assertStringIncludes(error.message, "design/remote-execution.md");
  assertStringIncludes(error.message, "labels");
});

Deno.test("StepSchema rejects removed driverConfig field with actionable error", () => {
  const error = assertThrows(
    () =>
      Step.fromData({
        name: "isolated",
        task: {
          type: "model_method",
          modelIdOrName: "test-model",
          methodName: "run",
        },
        driverConfig: { image: "node:18" },
      } as unknown as StepInput),
    Error,
  );
  assertStringIncludes(
    error.message,
    "The 'driverConfig' field has been removed",
  );
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

Deno.test("StepSchema throws clear error for string dependsOn entries", () => {
  assertThrows(
    () => {
      StepSchema.parse({
        name: "deploy",
        task: {
          type: "model_method",
          modelIdOrName: "my-model",
          methodName: "run",
        },
        dependsOn: ["build-step"],
      });
    },
    Error,
    "dependsOn entries must be objects, not strings",
  );
});

// Unknown-key rejection tests (swamp-club#1240)

Deno.test("StepSchema rejects typo'd placement key with did-you-mean suggestion", () => {
  // 'lables' would previously be stripped silently, discarding the
  // placement intent and running the step locally.
  const error = assertThrows(
    () =>
      StepSchema.parse({
        name: "echo",
        lables: { fb28: "probe" },
        task: {
          type: "model_method",
          modelIdOrName: "fb28-probe",
          methodName: "execute",
        },
      }),
    Error,
  );
  assertStringIncludes(error.message, "Unknown key 'lables' on step 'echo'");
  assertStringIncludes(error.message, "Did you mean 'labels'?");
});

Deno.test("StepSchema accepts all placement keys at step level", () => {
  const data = StepSchema.parse({
    name: "placed",
    task: {
      type: "model_method",
      modelIdOrName: "my-model",
      methodName: "run",
    },
    target: "worker-1",
    labels: { env: "prod" },
    platform: "linux/amd64",
    queueTimeout: 30,
  });
  assertEquals(data.labels, { env: "prod" });
  assertEquals(data.target, "worker-1");
});

Deno.test("Step placement: undefined when no placement fields are set", () => {
  const step = Step.fromData({
    name: "local",
    task: {
      type: "model_method",
      modelIdOrName: "my-model",
      methodName: "run",
    },
  });
  assertEquals(step.placement, undefined);
});

Deno.test("Step placement: empty labels object still means no placement", () => {
  const step = Step.fromData({
    name: "local",
    task: {
      type: "model_method",
      modelIdOrName: "my-model",
      methodName: "run",
    },
    labels: {},
  });
  assertEquals(step.placement, undefined);
});

Deno.test("Step placement: target, labels, and platform round-trip through toData", () => {
  const step = Step.fromData({
    name: "remote",
    task: {
      type: "model_method",
      modelIdOrName: "my-model",
      methodName: "run",
    },
    target: "ci-runner-3",
    labels: { gpu: "true", region: "us-east" },
    platform: "linux/x86_64",
  });
  assertEquals(step.placement, {
    target: "ci-runner-3",
    labels: { gpu: "true", region: "us-east" },
    platform: "linux/x86_64",
    queueTimeoutMs: undefined,
  });
  const restored = Step.fromData(step.toData());
  assertEquals(restored.placement, step.placement);
});

Deno.test("Step placement: queueTimeout converts seconds to milliseconds", () => {
  const step = Step.fromData({
    name: "queued",
    task: {
      type: "model_method",
      modelIdOrName: "my-model",
      methodName: "run",
    },
    target: "worker-1",
    queueTimeout: 30,
  });
  assertEquals(step.placement?.queueTimeoutMs, 30_000);
  assertEquals(step.queueTimeout, 30);
  const restored = Step.fromData(step.toData());
  assertEquals(restored.queueTimeout, 30);
  assertEquals(restored.placement?.queueTimeoutMs, 30_000);
});

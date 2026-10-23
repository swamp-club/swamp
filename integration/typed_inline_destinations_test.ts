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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  after,
  assertNothingLeaked,
  consume,
  type Fixture,
  gate,
  OUTPUT_PASSWORD,
  PASSWORD,
  quotes,
  type Run,
  TOKEN,
  TOKEN_KEY,
  withFixture,
  write,
} from "./typed_workflow_harness.ts";

const workflow = (steps: Step[], name = "routing") =>
  Workflow.create({
    name,
    jobs: [Job.create({ name: "main", steps })],
  });

const routes = [
  ...(["target", "platform", "labels"] as const).map((field) => ({
    path: `placement.${field}`,
    step: (value: string, _f: Fixture) =>
      Step.create({
        name: "route",
        task: StepTask.model("writer", "consume", {}),
        ...(field === "labels"
          ? { labels: { pool: value } }
          : { [field]: value }),
      }),
  })),
  ...(["modelIdOrName", "modelType", "modelName", "methodName"] as const)
    .map((field) => ({
      path: `task.${field}`,
      step: (value: string, f: Fixture) =>
        Step.create({
          name: "route",
          task: StepTask.fromData({
            type: "model_method",
            ...(field === "modelType" || field === "modelName"
              ? { modelType: f.type, modelName: "instance" }
              : { modelIdOrName: "writer" }),
            methodName: "consume",
            [field]: value,
          }),
        }),
    })),
  {
    path: "task.workflowIdOrName",
    step: (value: string, _f: Fixture) =>
      Step.create({
        name: "route",
        task: StepTask.workflow(value),
      }),
  },
];

async function assertRefused(
  f: Fixture,
  run: Run,
  path: string,
): Promise<void> {
  assertEquals(run.status, "failed", [...run.errors].join("\n"));
  const error = run.errors.get("route") ?? "";
  assertStringIncludes(error, "secret_destination_refused");
  assertStringIncludes(error, `route.${path}`);
  const failure = run.events.find((e) =>
    e.kind === "step_failed" && e.stepId === "route"
  );
  assertEquals(
    failure?.kind === "step_failed" && failure.errorCode,
    "secret_destination_refused",
  );
  assertEquals(f.loads, []);
  assertEquals(f.received, []);
  assertEquals(run.events.some((e) => e.kind === "step_queued"), false);
  await assertNothingLeaked(f, run);
}

for (const route of routes) {
  Deno.test(`typed inline destinations: ${route.path} refuses vault, data, query and step references with zero loads`, async () => {
    for (
      const source of [
        TOKEN,
        PASSWORD,
        '${{ data.query(\'modelName == "writer" && name == "c-quotes"\')[0].attributes.password }}',
        OUTPUT_PASSWORD,
      ]
    ) {
      await withFixture(async (f) => {
        await f.seed();
        // Concatenation also exercises the deferred scalar interpolation path.
        const step = route.step(`prefix-${source}-suffix`, f);
        const run = await f.run(
          workflow([
            write(),
            Step.create({
              ...step.toData(),
              task: step.task,
              dependsOn: after("write"),
            }),
          ]),
        );
        await assertRefused(f, run, route.path);
      });
    }
  });
}

Deno.test("typed inline destinations: a guard skips every routing destination without a vault check or load", async () => {
  {
    await withFixture(async (f) => {
      for (const route of routes) {
        const step = route.step(TOKEN, f);
        const run = await f.run(
          workflow([
            Step.fromData({ ...step.toData(), guard: "${{ true }}" }),
          ]),
        );
        assertEquals(run.skipped.get("route"), true);
        assertEquals(run.status, "succeeded");
      }
      assertEquals(f.loads, []);
      assertEquals(f.checks, []);
      assertEquals(f.received, []);
    });
  }
});

Deno.test("typed inline destinations: child targets refuse before invoking the child; the legacy target still loads and invokes", async () => {
  {
    await withFixture(async (f) => {
      f.rotate(TOKEN_KEY, "child");
      const parent = workflow([Step.create({
        name: "route",
        task: StepTask.workflow(TOKEN),
      })]);
      const child = workflow([consume("use", { note: "child ran" })], "child");
      const run = await f.run(parent, [child]);
      {
        await assertRefused(f, run, "task.workflowIdOrName");
      }
    });
  }
});

Deno.test("typed inline destinations: resumed and replayed routes refuse reconstructed references without loading", async () => {
  await withFixture(async (f) => {
    const parent = workflow([
      write(),
      gate(),
      Step.create({
        name: "route",
        task: StepTask.workflow(OUTPUT_PASSWORD),
        dependsOn: after("gate"),
      }),
    ]);
    const start = await f.run(parent);
    assertEquals(start.status, "suspended");
    assertEquals(f.loads, []);
    await f.approve(parent.name, start.runId!);
    await assertRefused(
      f,
      await f.resume(parent.name, start.runId!),
      "task.workflowIdOrName",
    );

    // A run-start expression becomes a sentinel in the evaluated cache. Replay
    // restores a new sentinel without loading and the literal route still refuses.
    await f.seed();
    const cached = workflow([Step.create({
      name: "route",
      task: StepTask.model("writer", PASSWORD),
    })], "cached-route");
    await assertRefused(f, await f.run(cached), "task.methodName");
    await assertRefused(
      f,
      await f.replay(cached.name),
      "task.methodName",
    );
  });
});

Deno.test("typed inline destinations: whole-field input and global argument records deliver secrets only at the method boundary", async () => {
  for (const field of ["inputs", "globalArgs"] as const) {
    {
      await withFixture(async (f) => {
        let resolutions = 0;
        f.hooks.directTypeResolver = (
          typeArg,
          name,
          _method,
          inputs,
          globalArgs,
        ) => {
          resolutions++;
          assertEquals(f.loads, []);
          return Promise.resolve({
            definition: Definition.create({
              name,
              type: typeArg,
              globalArguments: globalArgs,
            }),
            modelType: ModelType.create(typeArg),
            created: true,
            routedMethodInputs: inputs,
          });
        };
        const run = await f.run(
          workflow([
            write(),
            Step.create({
              name: "use",
              task: StepTask.fromData({
                type: "model_method",
                ...(field === "globalArgs"
                  ? { modelType: f.type, modelName: "direct" }
                  : { modelIdOrName: "writer" }),
                methodName: "consume",
                [field]: field === "globalArgs"
                  ? '${{ {"globalPassword": steps.write.outputs.password} }}'
                  : '${{ {"password": steps.write.outputs.password} }}',
              }),
              dependsOn: after("write"),
            }),
          ]),
        );
        assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
        assertEquals(f.received, [{ password: quotes(f) }]);
        assertEquals(resolutions, field === "globalArgs" ? 1 : 0);
        assertEquals(f.loads.length, 1);
        await assertNothingLeaked(f, run);
      });
    }
  }
});

Deno.test("typed inline destinations: plain env and deferred scalar targets retain their behavior", async () => {
  {
    await withFixture(async (f) => {
      await withMockedEnv({ SWAMP_3734_TARGET: "writer" }, async () => {
        const run = await f.run(
          workflow([
            Step.create({
              name: "plain",
              task: StepTask.model("${{ env.SWAMP_3734_TARGET }}", "consume", {
                note: "env",
              }),
            }),
            Step.create({
              name: "deferred",
              guard: "${{ false }}",
              task: StepTask.model("${{ inputs.target }}", "consume", {
                note: "input",
              }),
              dependsOn: after("plain"),
            }),
          ]),
          [],
          { target: "writer" },
        );
        assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
        assertEquals(f.received, [{ note: "env" }, { note: "input" }]);
        assertEquals(f.loads, []);
      });
    });
  }
});

Deno.test("typed inline destinations: an assert message already reduced to a sentinel masks with zero loads", async () => {
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(
      workflow([Step.create({
        name: "message",
        task: StepTask.assert("false", `already=${PASSWORD}`),
      })]),
    );
    assertEquals(run.asserts.get("message"), {
      passed: false,
      message: "already=***",
    });
    assertEquals(f.loads, []);
    await assertNothingLeaked(f, run);
  });
});

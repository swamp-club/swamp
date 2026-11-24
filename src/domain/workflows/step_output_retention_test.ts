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

import { assertEquals } from "@std/assert";
import { Definition } from "../definitions/definition.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import {
  type RetentionDefinitionFinder,
  StepOutputRetention,
  stepOutputRetentionFor,
} from "./step_output_retention.ts";
import { Workflow } from "./workflow.ts";

const retentionOf = (
  workflow: Workflow,
  find: RetentionDefinitionFinder,
  inherited?: Iterable<string>,
) => stepOutputRetentionFor([workflow], find, inherited);

const expr = (cel: string) => "${{ " + cel + " }}";

function workflowOf(steps: Step[]): Workflow {
  return Workflow.create({
    name: "wf",
    jobs: [Job.create({ name: "main", steps })],
  });
}

function writer(name = "write"): Step {
  return Step.create({
    name,
    task: StepTask.model("blobs", "write"),
    forEach: { item: "k", in: expr("inputs.keys") },
  });
}

function reader(
  value: string,
  props: { guard?: string; target?: string } = {},
): Step {
  return Step.create({
    name: "read",
    task: StepTask.model(props.target ?? "sink", "consume", { value }),
    ...(props.guard !== undefined ? { guard: props.guard } : {}),
  });
}

function finder(...definitions: Definition[]) {
  return (idOrName: string) =>
    Promise.resolve(
      definitions.find((d) => d.name === idOrName || d.id === idOrName) ??
        null,
    );
}

const blobs = Definition.create({ name: "blobs" });
const sink = Definition.create({ name: "sink" });

const keeps = (retention: StepOutputRetention, ...keys: string[]) =>
  keys.map((key) => retention.keepsStepOutputs(key));

Deno.test("stepOutputRetentionFor: keeps only the steps an expression names, by dot or literal key", async () => {
  const retention = await retentionOf(
    workflowOf([
      writer(),
      reader(
        expr(
          "steps.first.outputs.x + steps['write-b'].outputs.payload",
        ),
      ),
    ]),
    finder(blobs, sink),
  );
  assertEquals(keeps(retention, "first", "write-b", "write-a", "read"), [
    true,
    true,
    false,
    false,
  ]);
});

Deno.test("stepOutputRetentionFor: a computed steps key keeps every step", async () => {
  const retention = await retentionOf(
    workflowOf([writer(), reader(expr("steps['write-' + self.k].status"))]),
    finder(blobs, sink),
  );
  assertEquals(retention, StepOutputRetention.ALL);
});

Deno.test("stepOutputRetentionFor: the steps namespace used whole keeps every step", async () => {
  const retention = await retentionOf(
    workflowOf([writer(), reader(expr("size(steps)"))]),
    finder(blobs, sink),
  );
  assertEquals(retention, StepOutputRetention.ALL);
});

Deno.test("stepOutputRetentionFor: reads guards and bare assert predicates", async () => {
  const retention = await retentionOf(
    workflowOf([
      writer(),
      reader("plain", { guard: expr("steps.g.status == 'succeeded'") }),
      Step.create({
        name: "check",
        task: StepTask.assert("steps.a.outputs.ok == true", "a is ok"),
      }),
    ]),
    finder(blobs, sink),
  );
  assertEquals(keeps(retention, "g", "a", "write-x"), [true, true, false]);
});

Deno.test("stepOutputRetentionFor: reads the definitions of the models steps run and call through model.method", async () => {
  const consumer = Definition.create({
    name: "consumer",
    globalArguments: {
      seed: expr("steps.d.outputs.seed"),
      other: expr("model.method('helper', 'go').x"),
    },
  });
  const helper = Definition.create({
    name: "helper",
    globalArguments: { from: expr("steps.h.outputs.value") },
  });
  const retention = await retentionOf(
    workflowOf([writer(), reader("plain", { target: "consumer" })]),
    finder(blobs, consumer, helper),
  );
  assertEquals(keeps(retention, "d", "h", "write-x"), [true, true, false]);
});

Deno.test("stepOutputRetentionFor: a model chosen at run time, a missing definition or an unparsable expression keeps every step", async () => {
  const dynamic = await retentionOf(
    workflowOf([writer(), reader("plain", { target: expr("inputs.model") })]),
    finder(blobs, sink),
  );
  assertEquals(dynamic, StepOutputRetention.ALL);
  const missing = await retentionOf(
    workflowOf([writer(), reader("plain", { target: "absent" })]),
    finder(blobs, sink),
  );
  assertEquals(missing, StepOutputRetention.ALL);
  const unparsable = await retentionOf(
    workflowOf([writer(), reader(expr("steps.a.outputs.(("))]),
    finder(blobs, sink),
  );
  assertEquals(unparsable, StepOutputRetention.ALL);
});

Deno.test("stepOutputRetentionFor: an inherited expression is read as the run's own", async () => {
  const retention = await retentionOf(
    workflowOf([writer(), reader("plain")]),
    finder(blobs, sink),
    [expr("steps.parentNamed.outputs.v")],
  );
  assertEquals(keeps(retention, "parentNamed", "write-x"), [true, false]);
});

Deno.test("stepOutputRetentionFor: a model's data is read by name or id when an expression reads either", async () => {
  const retention = await retentionOf(
    workflowOf([
      writer(),
      reader(expr("model.blobs.resource.out.r.attributes.x")),
    ]),
    finder(blobs, sink),
  );
  assertEquals(
    [
      retention.readsModelData("blobs"),
      retention.readsModelData(blobs.id),
      retention.readsModelData("sink"),
    ],
    [true, true, false],
  );
});

Deno.test("stepOutputRetentionFor: a computed model key reads every model's data but keeps steps selective", async () => {
  const retention = await retentionOf(
    workflowOf([writer(), reader(expr("model[inputs.m].resource"))]),
    finder(blobs, sink),
  );
  assertEquals(retention.readsModelData("sink"), true);
  assertEquals(retention.keepsStepOutputs("write-x"), false);
});

Deno.test("stepOutputRetentionFor: a step named by either of two workflows is kept, as --last-evaluated reads its cache and the source", async () => {
  const retention = await stepOutputRetentionFor(
    [
      workflowOf([writer(), reader("plain")]),
      workflowOf([writer(), reader(expr("steps.cached.outputs.v"))]),
    ],
    finder(blobs, sink),
  );
  assertEquals(keeps(retention, "cached", "write-x"), [true, false]);
});

Deno.test("stepOutputRetentionFor: a direct execution reads the stored definition it adopts, and needs none to stay selective", async () => {
  const direct = Step.create({
    name: "deploy",
    task: StepTask.directExecution("x/y", "deployer", "run", {}),
  });
  const deployer = Definition.create({
    name: "deployer",
    globalArguments: { token: expr("steps.prep.outputs.token") },
  });
  const adopted = await retentionOf(
    workflowOf([writer(), direct]),
    finder(blobs, deployer),
  );
  assertEquals(keeps(adopted, "prep", "write-x"), [true, false]);
  const built = await retentionOf(
    workflowOf([writer(), direct]),
    finder(blobs),
  );
  assertEquals(keeps(built, "prep", "write-x"), [false, false]);
});

Deno.test("stepOutputRetentionFor: a fan-out job keeps every step, as its lanes run per-worker definitions", async () => {
  const fleet = Workflow.fromData(
    {
      id: crypto.randomUUID(),
      name: "fleet",
      jobs: [{
        name: "patch",
        fanOut: "all",
        labels: { role: "web" },
        steps: [{
          name: "apply",
          task: {
            type: "behavior",
            behaviorType: "command/shell",
            behaviorName: "patch",
            methodName: "execute",
          },
        }],
      }],
    } as unknown as Parameters<typeof Workflow.fromData>[0],
  );
  const retention = await stepOutputRetentionFor([fleet], finder(blobs));
  assertEquals(retention, StepOutputRetention.ALL);
});

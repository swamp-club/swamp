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
import {
  atSteps,
  type ReservedTagLookups,
  reservedWorkflowRunTag,
  reservedWorkflowTags,
} from "./reserved_workflow_tags.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";

const RESERVED = { "_swamp.sensitiveFields": "*" };

function workflowOf(
  name: string,
  steps: Array<{
    name: string;
    task: StepTask;
    overrideTags?: Record<string, string>;
  }>,
  tags?: Record<string, string>,
): Workflow {
  return Workflow.create({
    name,
    ...(tags ? { tags } : {}),
    jobs: [
      Job.create({
        name: "job",
        steps: steps.map((s) =>
          Step.create({
            name: s.name,
            task: s.task,
            ...(s.overrideTags
              ? {
                dataOutputOverrides: [{
                  specName: "out",
                  tags: s.overrideTags,
                }],
              }
              : {}),
          })
        ),
      }),
    ],
  });
}

const model = (ref: string) => StepTask.model(ref, "run");
const direct = (type: string, name: string) =>
  StepTask.fromData({
    type: "model_method",
    modelType: type,
    modelName: name,
    methodName: "run",
  });

/** Lookups over fixed definitions and workflows, recording each lookup. */
function lookupsOf(
  definitions: Record<string, Record<string, string>>,
  workflows: Workflow[] = [],
): ReservedTagLookups & { definitionLookups: string[] } {
  const definitionLookups: string[] = [];
  return {
    definitionLookups,
    findDefinition: (name) => {
      definitionLookups.push(name);
      const tags = definitions[name];
      return Promise.resolve(tags ? { name, tags } : null);
    },
    findWorkflow: (name) =>
      Promise.resolve(workflows.find((w) => w.name === name) ?? null),
  };
}

Deno.test("reservedWorkflowTags: finds the workflow's tags and every step override that hold a reserved key", async () => {
  const found = await reservedWorkflowTags(workflowOf("wf", [
    { name: "one", task: model("m"), overrideTags: RESERVED },
    { name: "two", task: model("m"), overrideTags: { ok: "1" } },
    { name: "three", task: model("m"), overrideTags: RESERVED },
  ], RESERVED));

  assertEquals(found.map((f) => f.steps.map((s) => s.stepName)), [
    [],
    ["one"],
    ["three"],
  ]);
  assertStringIncludes(
    atSteps(found[1]).text,
    "Step 'one' in job 'job': Tag",
  );
  assertEquals(atSteps(found[0]).text, found[0].refusal.text);
});

Deno.test("reservedWorkflowTags: is empty for a workflow without reserved keys", async () => {
  assertEquals(
    await reservedWorkflowTags(
      workflowOf("wf", [{ name: "one", task: model("m") }], { a: "b" }),
      lookupsOf({ m: { env: "dev" } }),
    ),
    [],
  );
});

Deno.test("reservedWorkflowTags: checks the definition a direct type execution adopts by modelName", async () => {
  const found = await reservedWorkflowTags(
    workflowOf("wf", [{
      name: "one",
      task: direct("command/shell", "adopted"),
    }]),
    lookupsOf({ adopted: RESERVED }),
  );

  assertEquals(found.length, 1);
  assertStringIncludes(
    atSteps(found[0]).text,
    "Step 'one' in job 'job': Tag '_swamp.sensitiveFields' from the tags of behavior definition 'adopted'",
  );
});

Deno.test("reservedWorkflowTags: looks each named definition up once and skips expressions", async () => {
  const lookups = lookupsOf({ plain: { env: "dev" } });

  await reservedWorkflowTags(
    workflowOf("wf", [
      { name: "one", task: model("plain") },
      { name: "two", task: model("plain") },
      { name: "three", task: model("${{ inputs.model }}") },
      { name: "four", task: direct("command/shell", "${{ inputs.name }}") },
      { name: "five", task: model("missing") },
    ]),
    lookups,
  );

  assertEquals(lookups.definitionLookups, ["plain", "missing"]);
});

Deno.test("reservedWorkflowTags: follows nested workflows and names the path to the key", async () => {
  const grandchild = workflowOf("grandchild", [
    { name: "deep", task: model("m"), overrideTags: RESERVED },
  ]);
  const child = workflowOf("child", [
    { name: "tagged", task: model("tagged") },
    { name: "deeper", task: StepTask.workflow("grandchild") },
  ], RESERVED);
  const parent = workflowOf("parent", [
    { name: "call", task: StepTask.workflow("child") },
  ]);

  const found = await reservedWorkflowTags(
    parent,
    lookupsOf({ tagged: RESERVED }, [child, grandchild]),
  );

  assertEquals(found.map((f) => atSteps(f).text.split(": Tag")[0]), [
    "Step 'call' in job 'job' (workflow 'child')",
    "Step 'call' in job 'job' (workflow 'child'): Step 'tagged' in job 'job'",
    "Step 'call' in job 'job' (workflow 'child'): Step 'deeper' in job 'job' (workflow 'grandchild'): Step 'deep' in job 'job'",
  ]);
});

Deno.test("reservedWorkflowTags: a cycle of nested workflows ends", async () => {
  const a = workflowOf("a", [{ name: "to-b", task: StepTask.workflow("b") }]);
  const b = workflowOf("b", [
    { name: "to-a", task: StepTask.workflow("a") },
    { name: "own", task: model("m"), overrideTags: RESERVED },
  ]);

  const found = await reservedWorkflowTags(a, lookupsOf({}, [a, b]));

  assertEquals(found.length, 1);
  assertStringIncludes(
    atSteps(found[0]).text,
    "Step 'to-b' in job 'job' (workflow 'b'): Step 'own' in job 'job':",
  );
});

Deno.test("reservedWorkflowTags: a lookup that throws counts as not found", async () => {
  const found = await reservedWorkflowTags(
    workflowOf("wf", [
      { name: "one", task: model("broken") },
      { name: "two", task: StepTask.workflow("broken") },
    ]),
    {
      findDefinition: () => Promise.reject(new Error("bad yaml")),
      findWorkflow: () => Promise.reject(new Error("bad yaml")),
    },
  );

  assertEquals(found, []);
});

Deno.test("reservedWorkflowRunTag: refuses --tag before looking up any definition", async () => {
  const lookups = lookupsOf({});

  const refusal = await reservedWorkflowRunTag(
    workflowOf("wf", [{ name: "one", task: model("plain") }]),
    RESERVED,
    lookups,
  );

  assertStringIncludes(refusal?.text ?? "", "from --tag is reserved");
  assertEquals(lookups.definitionLookups, []);
});

Deno.test("reservedWorkflowRunTag: refuses a named definition's reserved tag in both spellings", async () => {
  const refusal = await reservedWorkflowRunTag(
    workflowOf("wf", [{ name: "one", task: model("tagged") }]),
    undefined,
    lookupsOf({ tagged: RESERVED }),
  );

  assertStringIncludes(
    refusal?.text ?? "",
    "Step 'one' in job 'job': Tag '_swamp.sensitiveFields' from the tags of behavior definition 'tagged'",
  );
  assertStringIncludes(
    refusal?.modelText ?? "",
    "from the tags of model definition 'tagged'",
  );
});

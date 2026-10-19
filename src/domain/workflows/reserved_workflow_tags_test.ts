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
  atStep,
  reservedWorkflowRunTag,
  reservedWorkflowTags,
} from "./reserved_workflow_tags.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Definition } from "../definitions/definition.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { ModelType } from "../models/model_type.ts";

const RESERVED = { "_swamp.sensitiveFields": "*" };

function workflowOf(
  steps: Array<
    { name: string; model: string; overrideTags?: Record<string, string> }
  >,
  tags?: Record<string, string>,
): Workflow {
  return Workflow.create({
    name: "wf",
    ...(tags ? { tags } : {}),
    jobs: [
      Job.create({
        name: "job",
        steps: steps.map((s) =>
          Step.create({
            name: s.name,
            task: StepTask.model(s.model, "run"),
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

/** A repository holding `definitions` by name, counting its lookups. */
function definitionRepoOf(
  definitions: Record<string, Record<string, string>>,
): { repo: DefinitionRepository; lookups: string[] } {
  const lookups: string[] = [];
  const type = ModelType.create("command/shell");
  const repo = {
    findByNameGlobal: (name: string) => {
      lookups.push(name);
      const tags = definitions[name];
      return Promise.resolve(
        tags ? { definition: Definition.create({ name, tags }), type } : null,
      );
    },
  } as unknown as DefinitionRepository;
  return { repo, lookups };
}

Deno.test("reservedWorkflowTags: finds the workflow's tags and every step override that hold a reserved key", () => {
  const found = reservedWorkflowTags(workflowOf([
    { name: "one", model: "m", overrideTags: RESERVED },
    { name: "two", model: "m", overrideTags: { ok: "1" } },
    { name: "three", model: "m", overrideTags: RESERVED },
  ], RESERVED));

  assertEquals(found.map((f) => f.step?.stepName), [undefined, "one", "three"]);
  assertStringIncludes(atStep(found[1]).text, "Step 'one' in job 'job': Tag");
  assertEquals(atStep(found[0]).text, found[0].refusal.text);
});

Deno.test("reservedWorkflowTags: is empty for a workflow without reserved keys", () => {
  assertEquals(
    reservedWorkflowTags(workflowOf([{ name: "one", model: "m" }], { a: "b" })),
    [],
  );
});

Deno.test("reservedWorkflowRunTag: looks each literally named definition up once and skips expressions and missing ones", async () => {
  const { repo, lookups } = definitionRepoOf({ plain: { env: "dev" } });

  const refusal = await reservedWorkflowRunTag(
    workflowOf([
      { name: "one", model: "plain" },
      { name: "two", model: "plain" },
      { name: "three", model: "${{ inputs.model }}" },
      { name: "four", model: "missing" },
    ]),
    undefined,
    repo,
  );

  assertEquals(refusal, undefined);
  assertEquals(lookups, ["plain", "missing"]);
});

Deno.test("reservedWorkflowRunTag: refuses a named definition's reserved tag in both spellings", async () => {
  const { repo } = definitionRepoOf({ tagged: RESERVED });

  const refusal = await reservedWorkflowRunTag(
    workflowOf([{ name: "one", model: "tagged" }]),
    undefined,
    repo,
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

Deno.test("reservedWorkflowRunTag: refuses --tag before looking up any definition", async () => {
  const { repo, lookups } = definitionRepoOf({});

  const refusal = await reservedWorkflowRunTag(
    workflowOf([{ name: "one", model: "plain" }]),
    RESERVED,
    repo,
  );

  assertStringIncludes(refusal?.text ?? "", "from --tag is reserved");
  assertEquals(lookups, []);
});

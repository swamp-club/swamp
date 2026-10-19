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
import { Workflow } from "../workflows/workflow.ts";
import { Job } from "../workflows/job.ts";
import { Step } from "../workflows/step.ts";
import { StepTask } from "../workflows/step_task.ts";
import { findVaultReferences } from "./vault_reference_finder.ts";

function workflow(
  props: { vaults?: string[]; inputs?: Record<string, unknown> } = {},
): Workflow {
  return Workflow.create({
    name: "deploy",
    vaults: props.vaults,
    jobs: [
      Job.create({
        name: "build",
        steps: [
          Step.create({
            name: "compile",
            task: StepTask.model("app", "run", props.inputs),
          }),
        ],
      }),
    ],
  });
}

const none = { definitions: [], workflows: [] };

Deno.test("findVaultReferences: finds a definition's vault.get of the vault", () => {
  const definition = Definition.create({
    name: "app",
    globalArguments: { token: "${{ vault.get(trip-planner, API_KEY) }}" },
  });
  assertEquals(
    findVaultReferences("trip-planner", { ...none, definitions: [definition] }),
    {
      references: [{ kind: "definition", name: "app", via: "vault.get" }],
      possibleReferences: [],
    },
  );
});

Deno.test("findVaultReferences: reads a quoted vault argument", () => {
  const definition = Definition.create({
    name: "app",
    methods: {
      run: { arguments: { t: "${{ vault.get('trip-planner', \"KEY\") }}" } },
    },
  });
  const result = findVaultReferences("trip-planner", {
    ...none,
    definitions: [definition],
  });
  assertEquals(result.references.length, 1);
});

Deno.test("findVaultReferences: ignores vault.get of another vault", () => {
  const definition = Definition.create({
    name: "app",
    globalArguments: { token: "${{ vault.get(other, API_KEY) }}" },
  });
  assertEquals(
    findVaultReferences("trip-planner", { ...none, definitions: [definition] }),
    { references: [], possibleReferences: [] },
  );
});

Deno.test("findVaultReferences: a vault named only in plain text is not a reference", () => {
  const definition = Definition.create({
    name: "app",
    description: "vault.get(trip-planner, KEY) outside an expression",
  });
  assertEquals(
    findVaultReferences("trip-planner", { ...none, definitions: [definition] })
      .references,
    [],
  );
});

Deno.test("findVaultReferences: a static vault with a dynamic key is a reference", () => {
  const definition = Definition.create({
    name: "app",
    globalArguments: { token: "${{ vault.get(trip-planner, inputs.key) }}" },
  });
  assertEquals(
    findVaultReferences("trip-planner", { ...none, definitions: [definition] })
      .references,
    [{ kind: "definition", name: "app", via: "vault.get" }],
  );
});

Deno.test("findVaultReferences: a dynamic vault argument is a possible reference", () => {
  const definition = Definition.create({
    name: "app",
    globalArguments: { token: "${{ vault.get(inputs.vault, KEY) }}" },
  });
  assertEquals(
    findVaultReferences("trip-planner", { ...none, definitions: [definition] }),
    {
      references: [],
      possibleReferences: [{ kind: "definition", name: "app" }],
    },
  );
});

Deno.test("findVaultReferences: finds a definition's resource override vaultName", () => {
  const definition = Definition.create({
    name: "app",
    resources: { state: { vaultName: "trip-planner" } },
  });
  assertEquals(
    findVaultReferences("trip-planner", { ...none, definitions: [definition] })
      .references,
    [{ kind: "definition", name: "app", via: "resource override" }],
  );
});

Deno.test("findVaultReferences: finds a workflow's vault.get and vaults list", () => {
  const wf = workflow({
    vaults: ["trip-planner"],
    inputs: { token: "${{ vault.get(trip-planner, KEY) }}" },
  });
  assertEquals(
    findVaultReferences("trip-planner", { ...none, workflows: [wf] })
      .references,
    [
      { kind: "workflow", name: "deploy", via: "vault.get" },
      { kind: "workflow", name: "deploy", via: "vaults list" },
    ],
  );
});

Deno.test("findVaultReferences: a workflow allowing other vaults is not a reference", () => {
  const wf = workflow({ vaults: ["other"] });
  assertEquals(
    findVaultReferences("trip-planner", { ...none, workflows: [wf] }),
    { references: [], possibleReferences: [] },
  );
});

Deno.test("findVaultReferences: finds a vault.get in the datastore config", () => {
  const datastoreConfig = {
    type: "@swamp/s3-datastore",
    config: { secretKey: "${{ vault.get(trip-planner, AWS_SECRET) }}" },
  };
  assertEquals(
    findVaultReferences("trip-planner", { ...none, datastoreConfig })
      .references,
    [{ kind: "datastore", name: "datastore", via: "vault.get" }],
  );
});

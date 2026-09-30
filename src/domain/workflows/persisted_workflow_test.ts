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
import { RunSensitiveValues, vaultReferenceText } from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import {
  forEachNameWithoutSecrets,
  isIdentifierMapPath,
  persistEvaluatedWorkflow,
  rehydrateEvaluatedWorkflow,
} from "./persisted_workflow.ts";

const SECRET = "Pl41n-s3cret";
const SOURCE = { vaultName: "prod", key: "api-token" };
const REF = vaultReferenceText(SOURCE);

function recorded(): RunSensitiveValues {
  const values = new RunSensitiveValues();
  values.addSecret(SECRET, SOURCE);
  return values;
}

/** A workflow whose step task inputs, labels and tags all hold the secret. */
function workflowHolding(value: string): Workflow {
  return Workflow.create({
    name: "w",
    tags: { owner: value },
    labels: { team: value },
    jobs: [Job.create({
      name: "main",
      labels: { tier: value },
      steps: [Step.create({
        name: "s",
        labels: { role: value },
        task: StepTask.model("m", "run", {
          labels: value,
          tags: { nested: value },
          plain: `Bearer ${value}`,
        }),
      })],
    })],
  });
}

Deno.test("isIdentifierMapPath: matches only the workflow's identifier maps", () => {
  assertEquals(isIdentifierMapPath(["tags"]), true);
  assertEquals(isIdentifierMapPath(["labels"]), true);
  assertEquals(isIdentifierMapPath(["jobs", 0, "labels"]), true);
  assertEquals(isIdentifierMapPath(["jobs", 0, "steps", 1, "labels"]), true);
  assertEquals(
    isIdentifierMapPath([
      "jobs",
      0,
      "steps",
      1,
      "dataOutputOverrides",
      0,
      "tags",
    ]),
    true,
  );
  assertEquals(
    isIdentifierMapPath(["jobs", 0, "steps", 1, "task", "inputs", "labels"]),
    false,
  );
  assertEquals(
    isIdentifierMapPath(["jobs", 0, "steps", 1, "task", "inputs", "tags"]),
    false,
  );
  assertEquals(isIdentifierMapPath(["jobs", "main", "labels"]), false);
});

Deno.test("persistEvaluatedWorkflow: task inputs named labels or tags are written as references", () => {
  const persisted = persistEvaluatedWorkflow(
    workflowHolding(SECRET),
    workflowHolding(SECRET),
    undefined,
    [],
    recorded(),
  );
  const inputs = persisted.workflow.jobs[0].steps[0].task.data as {
    inputs: Record<string, unknown>;
  };
  assertEquals(inputs.inputs.labels, REF);
  assertEquals(inputs.inputs.tags, { nested: REF });
  assertEquals(inputs.inputs.plain, `Bearer ${REF}`);
  assertEquals(
    JSON.stringify(persisted.workflow.toData()).includes(SECRET),
    false,
  );
});

Deno.test("persistEvaluatedWorkflow: identifier maps carry placeholders, not references", () => {
  const persisted = persistEvaluatedWorkflow(
    workflowHolding(SECRET),
    workflowHolding(SECRET),
    undefined,
    [],
    recorded(),
  );
  const placeholder = "sensitive-prod.api-token";
  const data = persisted.workflow.toData();
  assertEquals(data.tags, { owner: placeholder });
  assertEquals(data.labels, { team: placeholder });
  assertEquals(data.jobs[0].labels, { tier: placeholder });
  assertEquals(data.jobs[0].steps[0].labels, { role: placeholder });
  // Placeholders are never listed for restoration.
  for (const ref of persisted.writtenReferences) {
    assertEquals(ref.path.includes("labels") && ref.path[4] !== "task", false);
  }
});

Deno.test("rehydrateEvaluatedWorkflow: a replay restores task inputs, including ones named tags", async () => {
  const persisted = persistEvaluatedWorkflow(
    workflowHolding(SECRET),
    workflowHolding(SECRET),
    undefined,
    [],
    recorded(),
  );
  const values = new RunSensitiveValues();
  const restored = await rehydrateEvaluatedWorkflow(
    {
      workflow: persisted.workflow,
      deferredExpressions: persisted.deferredExpressions,
      writtenReferences: persisted.writtenReferences,
    },
    () => Promise.resolve(SECRET),
    values,
  );
  const task = restored.workflow.jobs[0].steps[0].task.data as {
    inputs: Record<string, unknown>;
  };
  assertEquals(task.inputs, {
    labels: SECRET,
    tags: { nested: SECRET },
    plain: `Bearer ${SECRET}`,
  });
  assertEquals(values.list().map((e) => e.value), [SECRET]);
  // The overlay hands the step sentinels, not the value.
  const overlay = restored.sanitizedTasks!.forStep(
    restored.workflow.jobs[0].steps[0],
    new VaultSecretBag(),
  );
  assertEquals(JSON.stringify(overlay).includes(SECRET), false);
});

Deno.test("rehydrateEvaluatedWorkflow: a cache without references is used as stored", async () => {
  const workflow = workflowHolding("plain");
  const restored = await rehydrateEvaluatedWorkflow(
    { workflow, deferredExpressions: [], writtenReferences: [] },
    () => Promise.reject(new Error("not read")),
    new RunSensitiveValues(),
  );
  assertEquals(restored.workflow, workflow);
  assertEquals(restored.sanitizedTasks, undefined);
});

Deno.test("forEachNameWithoutSecrets: replaces each recorded value with the item index", () => {
  assertEquals(
    forEachNameWithoutSecrets(`deploy-${SECRET}`, 3, recorded()),
    "deploy-sensitive-3",
  );
  assertEquals(
    forEachNameWithoutSecrets("deploy-us-east", 3, recorded()),
    "deploy-us-east",
  );
});

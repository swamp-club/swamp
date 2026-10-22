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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { RunSensitiveValues, vaultReferenceText } from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { deferredExpressionReference } from "../expressions/deferred_expression.ts";
import { ProvenanceMap } from "../expressions/provenance_map.ts";
import {
  forEachNameWithoutSecrets,
  isIdentifierMapPath,
  persistEvaluatedWorkflow,
  recordableEvaluatedInputs,
  rehydrateEvaluatedWorkflow,
  replayInputs,
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
    new VaultSecretBag(new SecretBagRegistry()),
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

Deno.test("recordableEvaluatedInputs: inputs holding a sensitive value are withheld, with why (swamp-club#3583)", () => {
  const plain = { target: "scratch", envs: ["a", "b"] };
  assertEquals(recordableEvaluatedInputs(plain, recorded()), {
    inputs: plain,
  });
  assertEquals(recordableEvaluatedInputs(plain, new RunSensitiveValues()), {
    inputs: plain,
  });
  assertEquals(recordableEvaluatedInputs({}, recorded()), { inputs: {} });
  // Anywhere in the structure, whole or inside a longer string.
  assertEquals(recordableEvaluatedInputs({ tok: SECRET }, recorded()), {
    omitted: "sensitive",
  });
  assertEquals(
    recordableEvaluatedInputs(
      { nested: { header: `Bearer ${SECRET}` } },
      recorded(),
    ),
    { omitted: "sensitive" },
  );
});

const gated = { name: "gated" };

Deno.test("recordableEvaluatedInputs: origins accompany plain inputs and are withheld with sensitive ones", () => {
  const origins = {
    provenance: ProvenanceMap.authored().withWholeData("data"),
    inheritedExpressions: new Set(["${{ env.SOURCE }}"]),
  };
  assertEquals(
    recordableEvaluatedInputs({ data: "plain" }, recorded(), origins),
    {
      inputs: { data: "plain" },
      ...origins,
    },
  );
  assertEquals(
    recordableEvaluatedInputs({ data: SECRET }, recorded(), origins),
    {
      omitted: "sensitive",
    },
  );
});

Deno.test("replayInputs: inherited deferred inputs need their recorded provenance", () => {
  const inputs = { nested: [deferredExpressionReference(crypto.randomUUID())] };
  const cache = { workflow: gated, evaluatedInputs: inputs };
  const legacy = replayInputs(cache, {});
  assert("refusal" in legacy);
  assertStringIncludes(
    legacy.refusal,
    "inherited inputs without their provenance",
  );
  assertEquals(
    replayInputs({
      ...cache,
      evaluatedInputsProvenance: ProvenanceMap.authored(),
    }, {}),
    { inputs },
  );
});

Deno.test("replayInputs: a --last-evaluated run takes the inputs its cache recorded, under its own (swamp-club#3583)", () => {
  const recordedInputs = { target: "scratch", creds: { user: "u", key: "k" } };
  const cache = { workflow: gated, evaluatedInputs: recordedInputs };
  assertEquals(replayInputs(cache, {}), { inputs: recordedInputs });
  // The same value after the merge: no change.
  assertEquals(
    replayInputs(cache, { target: "scratch", creds: { key: "k" } }),
    { inputs: recordedInputs },
  );
  // A workflow evaluated with no inputs records an empty set, which replays.
  assertEquals(replayInputs({ workflow: gated, evaluatedInputs: {} }, {}), {
    inputs: {},
  });
});

Deno.test("replayInputs: refuses an input the cache was evaluated with another value for, or without, naming keys only", () => {
  const cache = { workflow: gated, evaluatedInputs: { target: "scratch" } };
  const other = replayInputs(cache, { target: "protected", region: "us" });
  assert("refusal" in other);
  assertStringIncludes(other.refusal, 'for --input "target", "region"');
  assertStringIncludes(
    other.refusal,
    "swamp workflow evaluate gated --input ...",
  );
  assertEquals(other.refusal.includes("protected"), false);
  assertEquals(other.refusal.includes("scratch"), false);
  // A nested change is a change of its top-level key.
  const nested = replayInputs(
    { workflow: gated, evaluatedInputs: { creds: { user: "u", key: "k" } } },
    { creds: { key: "other" } },
  );
  assert("refusal" in nested);
  assertStringIncludes(nested.refusal, '"creds"');
});

Deno.test("replayInputs: a cache that withheld its inputs for a secret is never replayed; a legacy cache is replayed once the workflow ran fresh", () => {
  const omitted = replayInputs(
    { workflow: gated, evaluatedInputsOmitted: "sensitive" },
    {},
  );
  assert("refusal" in omitted);
  assertStringIncludes(omitted.refusal, "held a secret");
  assertStringIncludes(omitted.refusal, "cannot be replayed");
  assertEquals(omitted.refusal.includes("once"), false);
  const legacy = replayInputs({ workflow: gated }, {});
  assert("refusal" in legacy);
  assertStringIncludes(
    legacy.refusal,
    "before the inputs it was evaluated with were recorded",
  );
  assertStringIncludes(
    legacy.refusal,
    "Run the workflow once without --last-evaluated",
  );
});

Deno.test("forEachNameWithoutSecrets: in a typed run every sentinel the run issued becomes the item index, taken from the sentinel and never a value (typed-secrets 4.1)", () => {
  const registry = new SecretBagRegistry({ typedSecrets: true });
  const values = new RunSensitiveValues(undefined, registry);
  const bag = new VaultSecretBag(registry);
  const vault = bag.addSecret({ vaultName: "prod", key: "A" }, "in");
  const data = bag.addDataReference({ vaultName: "prod", key: "B" }, "db");
  const other = `__SWAMP_VSEC_${"ab".repeat(16)}_0__`;
  assertEquals(
    forEachNameWithoutSecrets(`deploy-${vault}-${data}-${other}`, 2, values),
    `deploy-sensitive-2-sensitive-2-${other}`,
  );
  // Recorded values are still replaced beside the sentinels.
  values.addSecret(SECRET, SOURCE);
  assertEquals(
    forEachNameWithoutSecrets(`${vault}:${SECRET}`, 0, values),
    "sensitive-0:sensitive-0",
  );
  // An untyped run keeps a sentinel as text.
  assertEquals(
    forEachNameWithoutSecrets(`deploy-${vault}`, 2, recorded()),
    `deploy-${vault}`,
  );
});

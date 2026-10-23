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

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { UserError } from "../errors.ts";
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
  rehydrateRunReferences,
  replayInputs,
} from "./persisted_workflow.ts";
import { WorkflowRun } from "./workflow_run.ts";

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
  const writer = recorded();
  const sentinel = new VaultSecretBag(writer.sentinels).addDataReference(
    SOURCE,
    "inputs",
  );
  const persisted = persistEvaluatedWorkflow(
    workflowHolding(sentinel),
    undefined,
    [],
    writer,
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
  const writer = recorded();
  const sentinel = new VaultSecretBag(writer.sentinels).addDataReference(
    SOURCE,
    "inputs",
  );
  const persisted = persistEvaluatedWorkflow(
    workflowHolding(sentinel),
    undefined,
    [],
    writer,
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
  const writer = recorded();
  const sentinel = new VaultSecretBag(writer.sentinels).addDataReference(
    SOURCE,
    "inputs",
  );
  const persisted = persistEvaluatedWorkflow(
    workflowHolding(sentinel),
    undefined,
    [],
    writer,
  );
  const values = new RunSensitiveValues();
  const restored = await rehydrateEvaluatedWorkflow({
    workflow: persisted.workflow,
    deferredExpressions: persisted.deferredExpressions,
    writtenReferences: persisted.writtenReferences,
  }, values);
  const task = restored.workflow.jobs[0].steps[0].task.data as {
    inputs: Record<string, unknown>;
  };
  assertEquals(JSON.stringify(task.inputs).includes(SECRET), false);
  assertEquals(values.list(), []);
  assertEquals(
    persistEvaluatedWorkflow(restored.workflow, undefined, [], values).workflow
      .toData().jobs,
    persisted.workflow.toData().jobs,
  );
  // The overlay hands the step sentinels, not the value.
  const overlay = restored.sanitizedTasks!.forStep(
    restored.workflow.jobs[0].steps[0],
    new VaultSecretBag(new SecretBagRegistry()),
  );
  assertEquals(JSON.stringify(overlay).includes(SECRET), false);
});

Deno.test("rehydrateEvaluatedWorkflow: a cache without references is used as stored", async () => {
  const workflow = workflowHolding("plain");
  const restored = await rehydrateEvaluatedWorkflow({
    workflow,
    deferredExpressions: [],
    writtenReferences: [],
  }, new RunSensitiveValues());
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
  const registry = new SecretBagRegistry();
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

// --- typed-secrets 4.4: a typed replay holds references ---

/** A typed run's record. */
function typedValues(): RunSensitiveValues {
  return new RunSensitiveValues(
    undefined,
    new SecretBagRegistry(),
  );
}

/** A workflow a typed evaluation produced: two sentinels in one task input. */
function typedWorkflow(bag: VaultSecretBag): {
  workflow: Workflow;
  provenance: ProvenanceMap;
  first: string;
  second: string;
} {
  const first = bag.addSecret(SOURCE, "jobs[0].steps[0].task.inputs.auth");
  const second = bag.addDataReference(
    { vaultName: "prod", key: "db-password" },
    "data",
  );
  const workflow = Workflow.create({
    name: "typed",
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "s",
        task: StepTask.model("m", "run", {
          auth: `Bearer ${first} ${second} ${"${{ env.X }}"}`,
        }),
      })],
    })],
  });
  const provenance = ProvenanceMap.authored().withRanges(
    "jobs[0].steps[0].task.inputs.auth",
    [
      [7, 7 + first.length],
      [8 + first.length, 8 + first.length + second.length],
    ],
  );
  return { workflow, provenance, first, second };
}

Deno.test("persistEvaluatedWorkflow: a typed run's cache carries an exact persisted-coordinate map, and a typed replay restores one sentinel copy with no vault read whose map aligns back exactly", async () => {
  const writer = typedValues();
  const { workflow, provenance } = typedWorkflow(
    new VaultSecretBag(writer.sentinels),
  );
  const persisted = persistEvaluatedWorkflow(
    workflow,
    undefined,
    [],
    writer,
    provenance,
  );
  assertEquals(persisted.writtenReferences.length, 2);
  const auth = (persisted.workflow.jobs[0].steps[0].task.data as unknown as {
    inputs: { auth: string };
  }).inputs.auth;
  const second = vaultReferenceText({ vaultName: "prod", key: "db-password" });
  assertEquals(auth, `Bearer ${REF} ${second} ${"${{ env.X }}"}`);
  const path = "jobs[0].steps[0].task.inputs.auth";
  assertEquals(persisted.persistedProvenance!.rangesAt(path), [
    [7, 7 + REF.length],
    [8 + REF.length, 8 + REF.length + second.length],
  ]);

  const reader = typedValues();
  const reads = 0;
  const restored = await rehydrateEvaluatedWorkflow({
    workflow: persisted.workflow,
    deferredExpressions: persisted.deferredExpressions,
    writtenReferences: persisted.writtenReferences,
    persistedProvenance: persisted.persistedProvenance,
  }, reader);
  assertEquals(reads, 0);
  assertEquals(reader.isEmpty, true);
  const step = restored.workflow.jobs[0].steps[0];
  const restoredAuth =
    (step.task.data as unknown as { inputs: { auth: string } }).inputs
      .auth;
  const [a, b] = restoredAuth.match(VaultSecretBag.SENTINEL_PATTERN)!;
  assertEquals(restoredAuth, `Bearer ${a} ${b} ${"${{ env.X }}"}`);
  assertEquals(reader.sentinels.issuedEntryOf(a)?.reference, SOURCE);
  assertEquals(reader.sentinels.issuedEntryOf(b)?.dataOrigin, true);
  assertEquals(restored.provenance!.rangesAt(path), [
    [7, 7 + a.length],
    [8 + a.length, 8 + a.length + b.length],
  ]);
  assertEquals(
    restored.provenance!.overlapsData(
      path,
      restoredAuth.indexOf("${{"),
      restoredAuth.length,
    ),
    false,
  );
  // The overlay hands each step the same sentinels, rehomed into its bag
  // with their identity, and the step bag delivers through a load.
  const stepBag = new VaultSecretBag(reader.sentinels);
  const forStep = restored.sanitizedTasks!.forStep(step, stepBag) as {
    inputs: { auth: string };
  };
  const [ra, rb] = forStep.inputs.auth.match(VaultSecretBag.SENTINEL_PATTERN)!;
  assertEquals(reader.sentinels.issuedEntryOf(ra)?.reference, SOURCE);
  assertEquals(reader.sentinels.issuedEntryOf(rb)?.dataOrigin, true);
  assertEquals(
    stepBag.withLoaded(new Map([[ra, "A"], [rb, "B"]])).resolveRaw(
      forStep.inputs.auth,
    ),
    `Bearer A B ${"${{ env.X }}"}`,
  );
});

Deno.test("rehydrateEvaluatedWorkflow: a typed replay refuses a cache with references and a value-coordinate map only, and replays an unmapped cache as authored", async () => {
  const writer = typedValues();
  const { workflow, provenance } = typedWorkflow(
    new VaultSecretBag(writer.sentinels),
  );
  const persisted = persistEvaluatedWorkflow(
    workflow,
    undefined,
    [],
    writer,
  );
  assertEquals(persisted.persistedProvenance, undefined);
  assertThrows(
    () =>
      rehydrateEvaluatedWorkflow({ ...persisted, provenance }, typedValues()),
    UserError,
    "not replayed with references",
  );
  const unmapped = await rehydrateEvaluatedWorkflow(persisted, typedValues());
  assertEquals(unmapped.provenance?.isAuthored, true);
});

Deno.test("persistEvaluatedWorkflow: an untyped write marks every written reference's range in the persisted map, two in one string included", () => {
  const values = recorded();
  const sentinel = new VaultSecretBag(values.sentinels).addDataReference(
    SOURCE,
    "inputs",
  );
  const workflow = Workflow.create({
    name: "untyped",
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "s",
        task: StepTask.model("m", "run", {
          auth: `a ${sentinel} b ${sentinel} ${"${{ env.X }}"}`,
        }),
      })],
    })],
  });
  const path = "jobs[0].steps[0].task.inputs.auth";
  const raw = `a ${sentinel} b ${sentinel} ${"${{ env.X }}"}`;
  const provenance = ProvenanceMap.authored().withRanges(path, [
    [2, 2 + sentinel.length],
    [5 + sentinel.length, 5 + 2 * sentinel.length],
  ]);
  assertEquals(raw.slice(2, 2 + sentinel.length), sentinel);
  const persisted = persistEvaluatedWorkflow(
    workflow,
    undefined,
    [],
    values,
    provenance,
  );
  const auth = (persisted.workflow.jobs[0].steps[0].task.data as unknown as {
    inputs: { auth: string };
  }).inputs.auth;
  assertEquals(auth, `a ${REF} b ${REF} ${"${{ env.X }}"}`);
  const map = persisted.persistedProvenance!;
  // Each reference is data; the trailing expression is not.
  assertEquals(map.overlapsData(path, 2, 2 + REF.length), true);
  assertEquals(
    map.overlapsData(path, 5 + REF.length, 5 + 2 * REF.length),
    true,
  );
  assertEquals(
    map.overlapsData(path, auth.lastIndexOf("${{"), auth.length),
    false,
  );
});

// --- typed-secrets 4.4: a typed resume holds references ---

/** A run a typed run wrote: references in its inputs, bindings, error and prompt. */
function storedTypedRun(): {
  stored: ReturnType<WorkflowRun["toPersistedData"]>;
  a: string;
  b: string;
} {
  const workflow = Workflow.create({
    name: "resumed",
    jobs: [Job.create({
      name: "main",
      steps: [
        Step.create({ name: "s", task: StepTask.model("m", "run") }),
        Step.create({ name: "t", task: StepTask.model("m", "run") }),
      ],
    })],
  });
  const writer = typedValues();
  const bag = new VaultSecretBag(writer.sentinels);
  const a = bag.addSecret(SOURCE, "inputs.token");
  const b = bag.addDataReference(
    { vaultName: "prod", key: "db-password" },
    "d",
  );
  const run = WorkflowRun.create(workflow);
  run.attachSensitiveValues(writer);
  run.captureInputs({ token: `x ${a} y ${b} ${"${{ env.X }}"}`, plain: "p" });
  run.captureInputsProvenance(
    ProvenanceMap.authored().withRanges("token", [
      [2, 2 + a.length],
      [5 + a.length, 5 + a.length + b.length],
    ]),
  );
  run.captureDeferredExpressions([{
    id: "11111111-1111-4111-8111-111111111111",
    expression: "${{ inputs.token }}",
    bindings: { inputs: { token: `v ${a}`, other: "o" } },
    provenance: ProvenanceMap.authored().withRanges("inputs.token", [[0, 1]])
      .toData(),
  }]);
  run.start();
  const s = run.getJob("main")!.getStep("s")!;
  s.start();
  s.fail(`rejected ${a}`);
  return { stored: run.toPersistedData(), a, b };
}

Deno.test("rehydrateRunReferences: a typed resume restores every written reference as a sentinel of the run's registry, reads nothing, records no value, aligns the inputs map exactly, and writes the run back as it was read", () => {
  const { stored } = storedTypedRun();
  assertEquals(JSON.stringify(stored).includes("__SWAMP_VSEC_"), false);
  assertEquals(
    (stored.writtenReferences ?? []).map((r) => r.path.join(".")).sort(),
    [
      "deferredExpressions.0.bindings.inputs.token",
      "failureReason",
      "inputs.token",
      "inputs.token",
      "jobs.0.steps.0.error",
    ],
  );
  const values = typedValues();
  const run = rehydrateRunReferences(WorkflowRun.fromData(stored), values);
  assertEquals(values.isEmpty, true);
  const token = run.inputs.token as string;
  const [a, b] = token.match(VaultSecretBag.SENTINEL_PATTERN)!;
  assertEquals(token, `x ${a} y ${b} ${"${{ env.X }}"}`);
  assertEquals(values.sentinels.issuedEntryOf(a)?.reference, SOURCE);
  assertEquals(values.sentinels.issuedEntryOf(a)?.dataOrigin, false);
  assertEquals(values.sentinels.issuedEntryOf(b)?.dataOrigin, true);
  const entryA = values.sentinels.issuedEntryOf(a);
  assertEquals(
    entryA !== undefined && "location" in entryA ? entryA.location : undefined,
    "run " + run.id + ": inputs.token",
  );
  for (const entry of values.sentinels.all()) {
    assertEquals("value" in entry, false);
  }
  const error = run.getJob("main")!.getStep("s")!.error!;
  const [e] = error.match(VaultSecretBag.SENTINEL_PATTERN)!;
  assertEquals(error, `rejected ${e}`);
  assertEquals(values.sentinels.issuedEntryOf(e)?.reference, SOURCE);
  const bound = run.deferredExpressions[0].bindings.inputs as { token: string };
  const [d] = bound.token.match(VaultSecretBag.SENTINEL_PATTERN)!;
  assertEquals(bound.token, `v ${d}`);
  // The inputs map follows the sentinel copy exactly.
  const map = run.inputsProvenance!;
  assertEquals(map.rangesAt("token"), [
    [2, 2 + a.length],
    [5 + a.length, 5 + a.length + b.length],
  ]);
  assertEquals(
    map.overlapsData("token", token.lastIndexOf("${{"), token.length),
    false,
  );
  // A deferred binding holding a reference is whole data in its map; its
  // sibling keeps its own standing.
  const deferredMap = ProvenanceMap.fromData(
    run.deferredExpressions[0].provenance!,
  );
  assertEquals(deferredMap.isWholeDataAt("inputs.token"), true);
  assertEquals(deferredMap.hasDataAtOrBelow("inputs.other"), false);
  // Written back, the record is what it was.
  const again = run.toPersistedData();
  assertEquals(again.inputs, stored.inputs);
  assertEquals(
    again.deferredExpressions?.[0].bindings,
    stored.deferredExpressions?.[0].bindings,
  );
  assertEquals(again.jobs[0].steps[0].error, stored.jobs[0].steps[0].error);
  assertEquals(
    again.persistedInputsProvenance,
    stored.persistedInputsProvenance,
  );
  assertEquals(
    [...(again.writtenReferences ?? [])].map((r) => r.path.join(".")).sort(),
    [...(stored.writtenReferences ?? [])].map((r) => r.path.join(".")).sort(),
  );
});

Deno.test("rehydrateRunReferences: a record without the persisted inputs map fails closed, each input string holding a reference becoming whole data, and one with no map derives nothing", () => {
  const { stored } = storedTypedRun();
  const { persistedInputsProvenance: _dropped, ...older } = stored;
  const values = typedValues();
  const run = rehydrateRunReferences(WorkflowRun.fromData(older), values);
  assertEquals(run.inputsProvenance!.isWholeDataAt("token"), true);
  assertEquals(run.inputsProvenance!.hasDataAtOrBelow("plain"), false);
  const { inputsProvenance: _noMap, ...unmapped } = older;
  const derived = rehydrateRunReferences(
    WorkflowRun.fromData(unmapped),
    typedValues(),
  );
  assertEquals(derived.inputsProvenance, undefined);
  // The untyped branch is not this function's; a record with no references
  // is returned with the values attached and nothing issued.
  const plainValues = typedValues();
  const { writtenReferences: _refs, ...noRefs } = older;
  const plain = rehydrateRunReferences(
    WorkflowRun.fromData({ ...noRefs, inputs: { plain: "p" } }),
    plainValues,
  );
  assertEquals(plainValues.sentinels.isEmpty, true);
  assertEquals(plain.inputs, { plain: "p" });
});

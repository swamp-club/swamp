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

/**
 * The persistence seams of typed secrets, end to end (design/enablers/
 * typed-secrets.md Sections 8.1, 8.2 and the Persistence row of 12.1,
 * typed-secrets 4.4): a run that suspends and resumes, and a replay of its
 * cache. Every seam round-trips through
 * writtenReferences, the run index holds reference text, the output
 * records and the catalog hold neither a value nor a sentinel, a record
 * written with the json, number and boolean encodings of an untyped run
 * reads back and delivers each as Section 8.1 says, and sentinel-shaped
 * text from another prefix persists as data. The v3 copies are the same
 * bytes the repositories write, asserted at the staging boundary in the
 * repository tests.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { readRunIndex } from "../src/infrastructure/persistence/workflow_run_index.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import { ProvenanceMap } from "../src/domain/expressions/provenance_map.ts";
import { vaultReferenceText } from "../src/domain/secrets/run_sensitive_values.ts";
import { SENSITIVE_FORMAT_VERSION } from "../src/domain/secrets/persisted_sensitive_form.ts";

import {
  createWorkflowEvaluateDeps,
  workflowEvaluate,
} from "../src/libswamp/workflows/evaluate.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  assertNothingLeaked,
  consume,
  type Fixture,
  PASSWORD,
  quotes,
  type Run,
  SENTINEL_MARK,
  TOKEN,
  TOKEN_KEY,
  VAULT,
  withFixture,
} from "./typed_workflow_harness.ts";

const CHILD = "persist-child";
const PARENT = "persist-parent";
const FOREIGN = `__SWAMP_VSEC_${"f".repeat(32)}_0__`;

/** A child whose inputs carry the parent's secrets and whose gate echoes one. */
const child = () =>
  Workflow.create({
    name: CHILD,
    inputs: {
      properties: {
        secret: { type: "string" },
        token: { type: "string" },
        tag: { type: "string" },
      },
    },
    jobs: [Job.create({
      name: "main",
      steps: [
        Step.create({
          name: "gate",
          task: StepTask.manualApproval("approve ${{ inputs.secret }}"),
        }),
        consume("use", {
          password: "${{ inputs.secret }}",
          note: "${{ inputs.token }}",
        }, { dependsOn: "gate" }),
      ],
    })],
  });

const parent = () =>
  Workflow.create({
    name: PARENT,
    jobs: [Job.create({
      name: "main",
      steps: [
        Step.create({
          name: "call",
          task: StepTask.workflow(CHILD, {
            secret: PASSWORD,
            token: TOKEN,
            tag: FOREIGN,
          }),
        }),
      ],
    })],
  });

/** The stored record and the workflow of a run, as the repositories read them. */
async function stored(f: Fixture, workflowName: string, runId: string) {
  const workflow = await new YamlWorkflowRepository(f.repoDir).findByName(
    workflowName,
  );
  assert(workflow, `no workflow ${workflowName}`);
  const run = await new YamlWorkflowRunRepository(f.repoDir).findById(
    workflow.id,
    createWorkflowRunId(runId),
  );
  assert(run, `no run ${runId}`);
  const runsDir = join(f.repoDir, ".swamp", "workflow-runs", workflow.id);
  return { workflow, run, data: run.toData(), runsDir };
}

/** The nested child run a parent's suspension names. */
function nestedRunId(run: Run): string {
  const suspended = run.events.find((e) => e.kind === "suspended");
  assert(suspended && suspended.kind === "suspended", "no suspension");
  assert(suspended.nested, "the suspension names no nested run");
  return suspended.nested.runId;
}

/** Fails when a file holds any sentinel-shaped text other than the foreign input. */
async function assertOnlyForeignSentinels(f: Fixture): Promise<void> {
  for (const path of await f.filesHolding(SENTINEL_MARK)) {
    const text = (await Deno.readTextFile(join(f.repoDir, path)))
      .split(FOREIGN).join("");
    assertEquals(
      text.includes(SENTINEL_MARK),
      false,
      `${path} holds a sentinel`,
    );
  }
}

/** Fails when the catalog file holds a forbidden value or a sentinel. */
async function assertCatalogClean(f: Fixture): Promise<void> {
  const bytes = await Deno.readFile(join(f.repoDir, "_catalog.db"));
  const text = new TextDecoder("latin1").decode(bytes);
  for (const value of f.forbidden) {
    assertEquals(text.includes(value), false, "the catalog holds a value");
  }
  assertEquals(text.includes(SENTINEL_MARK), false, "catalog sentinel");
}

Deno.test("typed persistence: a suspended child run's record, caches and index hold references and the persisted maps; the typed resume restores references, loads the rotated values once each at delivery and reruns no completed step", async () => {
  {
    await withFixture(async (f) => {
      await f.seed();
      const run = await f.run(parent(), [child()]);
      assertEquals(run.status, "suspended", [...run.errors].join("\n"));
      const childRunId = nestedRunId(run);
      // Nothing delivered yet: a typed run loaded nothing to get here.
      assertEquals(f.loads, []);

      const storedKey = await f.storedKey("c-quotes");
      const secretRef = vaultReferenceText({
        vaultName: VAULT,
        key: storedKey,
      });
      const { data, runsDir } = await stored(f, CHILD, childRunId);
      // The record: a reference where the run held the data-read secret,
      // the parent's vault.get deferred to the child's own delivery, the
      // foreign sentinel-shaped input as data, and both maps.
      assertEquals(data.inputs?.secret, secretRef);
      assertStringIncludes(String(data.inputs?.token), "__swamp_deferred_");
      assertEquals(data.inputs?.tag, FOREIGN);
      assertEquals(data.sensitiveFormat, SENSITIVE_FORMAT_VERSION);
      const written = (data.writtenReferences ?? []).map((w) =>
        [w.path.join("."), w.key, w.dataOrigin] as const
      );
      // A typed run issued a data-origin reference for the read; the untyped
      // value search records the plaintext it found with no origin.
      assertEquals(
        written.filter(([path]) => path.startsWith("inputs")),
        [["inputs.secret", storedKey, true]],
      );
      assertEquals(
        data.jobs[0].steps[0].approvalPrompt,
        `approve ${secretRef}`,
      );
      assert(
        written.some(([path]) => path === "jobs.0.steps.0.approvalPrompt"),
      );
      assert(data.persistedInputsProvenance, "no persisted inputs map");
      assert(data.inputsProvenance, "no inputs map");
      // The run index holds the same reference text, never a sentinel.
      const index = await readRunIndex(runsDir);
      assertEquals(index?.entries[childRunId]?.inputs, data.inputs);
      // The child's evaluated cache and run snapshot hold references too.
      const cacheRepo = new YamlEvaluatedWorkflowRepository(f.repoDir);
      const cache = await cacheRepo.findByNameWithProvenance(CHILD);
      assert(cache, "no evaluated cache");
      assert(
        cache.writtenReferences.length > 0,
        "the cache wrote no reference",
      );
      assert(cache.persistedProvenance instanceof ProvenanceMap);
      assert(await cacheRepo.findByRunId(childRunId), "no run snapshot");
      // The parent's data read is deferred to the call step, so its cache
      // holds no reference, only its persisted map.
      const parentCache = await cacheRepo.findByNameWithProvenance(PARENT);
      assert(parentCache);
      assertEquals(parentCache.writtenReferences, []);
      assert(parentCache.persistedProvenance instanceof ProvenanceMap);
      // Only the foreign sentinel-shaped input sits in any file, as data.
      await assertOnlyForeignSentinels(f);
      for (const value of f.forbidden) {
        assertEquals(await f.filesHolding(value), [], `files hold ${value}`);
      }
      await assertCatalogClean(f);

      // The vault rotates while the run waits.
      const rotatedSecret = `rotated-${crypto.randomUUID()}`;
      const rotatedToken = `token-${crypto.randomUUID()}`;
      f.rotate(storedKey, rotatedSecret);
      f.rotate(TOKEN_KEY, rotatedToken);
      f.forbidden.push(rotatedSecret, rotatedToken);
      await f.approve(CHILD, childRunId);
      const before = f.loads.length;
      const resumed = await f.resume(CHILD, childRunId);
      assertEquals(resumed.status, "succeeded", [...resumed.errors].join("\n"));
      // The remaining step delivered the current values, once each; the
      // approved gate did not run again.
      assertEquals(f.received, [{
        password: rotatedSecret,
        note: rotatedToken,
      }]);
      {
        assertEquals(
          f.loads.slice(before).sort(),
          [storedKey, TOKEN_KEY].sort(),
        );
      }
      // The record is written back as it was read, references in place.
      const again = await stored(f, CHILD, childRunId);
      assertEquals(again.data.inputs, data.inputs);
      assertEquals(
        again.data.jobs[0].steps[0].approvalPrompt,
        data.jobs[0].steps[0].approvalPrompt,
      );
      assert(again.data.persistedInputsProvenance);
      await assertNothingLeaked(f, resumed, { allowed: [FOREIGN] });
      await assertCatalogClean(f);
    });
  }
});

Deno.test("typed persistence: a typed replay of the evaluated cache reads nothing to restore and the child it calls delivers the rotated values once each", async () => {
  // The data read the parent hands the child is deferred to the call step,
  // and a child cache whose inputs held a secret withholds its inputs and is
  // never replayed, so the replay that reaches a delivery end to end is the
  // parent's: its cache holds the deferred expressions and its persisted map,
  // the replay reads nothing to restore, and the child's delivery loads the
  // current values. A cache that holds references restores them through
  // rehydrateEvaluatedWorkflow, covered in persisted_workflow_test.ts.
  const CALLEE = "persist-replay-child";
  const CALLER = "persist-replay";
  const callee = () =>
    Workflow.create({
      name: CALLEE,
      inputs: {
        properties: { secret: { type: "string" }, token: { type: "string" } },
      },
      jobs: [Job.create({
        name: "main",
        steps: [
          consume("use", {
            password: "${{ inputs.secret }}",
            note: "${{ inputs.token }}",
          }),
        ],
      })],
    });
  const caller = () =>
    Workflow.create({
      name: CALLER,
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call",
            task: StepTask.workflow(CALLEE, { secret: PASSWORD, token: TOKEN }),
          }),
        ],
      })],
    });
  {
    await withFixture(async (f) => {
      await f.seed();
      const first = await f.run(caller(), [callee()]);
      assertEquals(first.status, "succeeded", [...first.errors].join("\n"));
      assertEquals(f.received, [{ password: quotes(f), note: f.token }]);
      const cache = await new YamlEvaluatedWorkflowRepository(f.repoDir)
        .findByNameWithProvenance(CALLER);
      assert(cache);
      assertEquals(cache.writtenReferences, []);
      assert(cache.persistedProvenance instanceof ProvenanceMap);
      for (const value of f.forbidden) {
        assertEquals(await f.filesHolding(value), [], `files hold ${value}`);
      }

      const storedKey = await f.storedKey("c-quotes");
      const rotatedSecret = `rotated-${crypto.randomUUID()}`;
      const rotatedToken = `token-${crypto.randomUUID()}`;
      f.rotate(storedKey, rotatedSecret);
      f.rotate(TOKEN_KEY, rotatedToken);
      f.forbidden.push(rotatedSecret, rotatedToken);
      f.received.length = 0;
      const before = f.loads.length;
      const replay = await f.replay(CALLER);
      assertEquals(replay.status, "succeeded", [...replay.errors].join("\n"));
      assertEquals(f.received, [{
        password: rotatedSecret,
        note: rotatedToken,
      }]);
      {
        // One load per reference, at the child's delivery: nothing was read
        // to restore the parent's cache.
        assertEquals(
          f.loads.slice(before).sort(),
          [storedKey, TOKEN_KEY].sort(),
        );
        await assertNothingLeaked(f, replay);
      }
      for (const value of f.forbidden) {
        assertEquals(await f.filesHolding(value), [], `files hold ${value}`);
      }
    });
  }
});

Deno.test("typed persistence: a record an untyped run wrote with json, number and boolean entries and no persisted map reads back: the typed resume delivers each as Section 8.1 says, keeps the foreign sentinel-shaped input as data, and writes the references back", async () => {
  const NAME = "persist-encodings";
  const workflow = () =>
    Workflow.create({
      name: NAME,
      inputs: {
        properties: {
          port: { type: "string" },
          body: { type: "string" },
          on: { type: "string" },
          tag: { type: "string" },
        },
      },
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("wait"),
          }),
          consume("use", {
            note: "${{ inputs.port }}-${{ inputs.on }}",
            password: "${{ inputs.body }}",
          }, { dependsOn: "gate" }),
        ],
      })],
    });
  {
    await withFixture(async (f) => {
      // A digit string long enough never to occur by chance in an id, a
      // timestamp or a duration, so its absence from every file is a real
      // check, and short enough that the untyped rehydrate's number keeps
      // every digit; it still exercises the number encoding.
      const port = String(
        100_000_000_000_000n +
          crypto.getRandomValues(new BigUint64Array(1))[0] %
            900_000_000_000_000n,
      );
      f.rotate("port", port);
      f.rotate("body", 'p"w');
      f.rotate("flag", "true");
      f.forbidden.push(port, 'p"w');
      // Run with plain inputs, then rewrite the suspended record as an
      // untyped run that read secrets would have written it.
      const run = await f.run(workflow(), [], {
        port: "x",
        body: "y",
        on: "z",
        tag: FOREIGN,
      });
      assertEquals(run.status, "suspended", [...run.errors].join("\n"));
      assert(run.runId);
      const refOf = (key: string) =>
        vaultReferenceText({ vaultName: VAULT, key });
      await f.editRun(NAME, run.runId, (data) => {
        data.inputs = {
          port: refOf("port"),
          body: `{"k":"${refOf("body")}"}`,
          on: refOf("flag"),
          tag: FOREIGN,
        };
        data.writtenReferences = [
          {
            path: ["inputs", "port"],
            occurrence: 0,
            vaultName: VAULT,
            key: "port",
            encoding: "number",
            dataOrigin: false,
          },
          {
            path: ["inputs", "body"],
            occurrence: 0,
            vaultName: VAULT,
            key: "body",
            encoding: "json",
            dataOrigin: false,
          },
          {
            path: ["inputs", "on"],
            occurrence: 0,
            vaultName: VAULT,
            key: "flag",
            encoding: "boolean",
            dataOrigin: true,
          },
        ];
        data.sensitiveFormat = SENSITIVE_FORMAT_VERSION;
        delete data.persistedInputsProvenance;
      });
      await f.approve(NAME, run.runId);
      const resumed = await f.resume(NAME, run.runId);
      assertEquals(resumed.status, "succeeded", [...resumed.errors].join("\n"));
      // The number and boolean deliver their text, the json entry the escaped form.
      assertEquals(f.received, [{
        note: `${port}-true`,
        password: '{"k":"p\\"w"}',
      }]);
      const { data } = await stored(f, NAME, run.runId);
      assertEquals(data.inputs?.tag, FOREIGN);
      assertEquals(data.inputs?.port, refOf("port"));
      assertEquals(data.inputs?.body, `{"k":"${refOf("body")}"}`);
      assertEquals(data.inputs?.on, refOf("flag"));
      const encodings = (data.writtenReferences ?? [])
        .filter((w) => w.path[0] === "inputs")
        .map((w) => [w.path[1], w.encoding, w.dataOrigin]).sort();
      // A typed resume writes each entry back as it was read; the untyped
      // value search records the plaintext it found with no origin.
      assertEquals(encodings, [
        ["body", "json", false],
        ["on", "boolean", true],
        ["port", "number", false],
      ]);
      for (const value of [port, 'p"w']) {
        assertEquals(await f.filesHolding(value), [], `files hold ${value}`);
      }
      await assertNothingLeaked(f, resumed, { allowed: [FOREIGN] });
    });
  }
});

Deno.test("typed persistence: swamp workflow evaluate over a typed registry expands a forEach over tagged records and writes its cache from registry entries with zero loads and no probe", async () => {
  const NAME = "persist-evaluate";
  const workflow = () =>
    Workflow.create({
      name: NAME,
      jobs: [Job.create({
        name: "main",
        steps: [
          consume("use-${{ self.c.attributes.host }}", {
            password: "${{ self.c.attributes.password }}",
            note: "${{ self.c.attributes.host }}",
          }, {
            forEach: {
              item: "c",
              in: "${{ data.findBySpec('writer', 'creds') }}",
            },
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    await f.seed();
    const workflowRepo = new YamlWorkflowRepository(f.repoDir);
    await workflowRepo.save(workflow());
    const evaluate = async () => {
      const deps = createWorkflowEvaluateDeps(f.repoDir, workflowRepo);
      const events = await collect(workflowEvaluate(
        createLibSwampContext(),
        {
          ...deps,
        },
        { workflowIdOrName: NAME, inputs: {} },
      ));
      assertEquals(events.some((e) => e.kind === "error"), false);
      const cache = await new YamlEvaluatedWorkflowRepository(f.repoDir)
        .findByNameWithProvenance(NAME);
      assert(cache);
      return { events, cache };
    };
    const typed = await evaluate();
    // The data-origin references are authorized, not probed, and nothing
    // is delivered: no load and no check.
    assertEquals(f.loads, []);
    assertEquals(f.checks, []);
    assertEquals(typed.cache.writtenReferences.length, f.canaries.length);
    assert(typed.cache.persistedProvenance instanceof ProvenanceMap);
    assertEquals(typed.cache.workflow.jobs[0].steps.length, f.canaries.length);
    for (const value of f.forbidden) {
      assertEquals(await f.filesHolding(value), [], `files hold ${value}`);
      assertEquals(JSON.stringify(typed.events).includes(value), false);
    }
    assertEquals(await f.filesHolding(SENTINEL_MARK), []);
  });
});

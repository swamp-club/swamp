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

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  cancelledOutcome,
  registrationOf,
  type WaitOutcome,
} from "./signal_wait_records.ts";
import { SignalWait } from "./signal_wait.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import { InMemorySignalWaitStore } from "./signal_wait_store_test_helpers.ts";
import {
  claimWaitKey,
  decideKeyHolder,
  declaredWaitKeyStep,
  decodeWaitKeyRecord,
  encodeWaitKeyRecord,
  findKeyHolder,
  findSettledKeyHolder,
  releaseKeyClaims,
  WAIT_KEY_RECORD_MAX_BYTES,
  WAIT_KEY_UNREGISTERED_GRACE_MS,
  waitKeyAddressFromKey,
  type WaitKeyClaim,
  waitKeyPrefix,
  waitKeyRecordKey,
  waitKeyRefusal,
  type WaitKeyRequest,
  waitKeyWorkflowPrefix,
  waitRefOfClaim,
} from "./wait_key_claim.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const DEADLINE = "2026-01-01T01:00:00.000Z";
const PAST_DEADLINE = new Date("2026-01-01T01:00:00.001Z");
const WORKFLOW = "wf-release";

function request(overrides: Partial<WaitKeyRequest> = {}): WaitKeyRequest {
  return {
    workflowId: WORKFLOW,
    key: "verdict",
    waitId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    jobName: "main",
    stepName: "review",
    deadline: DEADLINE,
    ...overrides,
  };
}

function claimOf(overrides: Partial<WaitKeyClaim> = {}): WaitKeyClaim {
  return {
    kind: "claim",
    workflowId: WORKFLOW,
    key: "verdict",
    generation: 1,
    recordedAt: NOW.toISOString(),
    waitId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    jobName: "main",
    stepName: "review",
    deadline: DEADLINE,
    ...overrides,
  };
}

async function acquire(
  store: InMemorySignalWaitStore,
  overrides: Partial<WaitKeyRequest> = {},
  now = NOW,
): Promise<WaitKeyClaim> {
  const result = await claimWaitKey(store, request(overrides), now);
  assert(result.kind === "acquired", `got ${result.kind}`);
  return result.claim;
}

function cancelled(claim: WaitKeyClaim): WaitOutcome {
  return cancelledOutcome(waitRefOfClaim(claim), NOW);
}

Deno.test("waitKeyRecordKey: builds wait-keys/<workflow>/<key>/<generation> and reads it back", () => {
  const at = { workflowId: WORKFLOW, key: "kitchen-verdict", generation: 12 };
  assertEquals(waitKeyRecordKey(at), "wait-keys/wf-release/kitchen-verdict/12");
  assertEquals(waitKeyAddressFromKey(waitKeyRecordKey(at)), at);
  assertEquals(waitKeyPrefix(WORKFLOW, "a"), "wait-keys/wf-release/a/");
  assertEquals(waitKeyWorkflowPrefix(WORKFLOW), "wait-keys/wf-release/");
});

Deno.test("waitKeyRecordKey: refuses a workflow id, a key or a generation that could name another place", () => {
  for (const workflowId of ["", ".", "..", "a/b", "a\\b"]) {
    assertThrows(() => waitKeyWorkflowPrefix(workflowId), Error, "workflow id");
  }
  for (
    const key of ["", "Verdict", "a/b", "..", ".", "-a", "_a", "a b", "é"]
  ) {
    assertThrows(() => waitKeyPrefix(WORKFLOW, key), Error, "wait key");
  }
  assertThrows(() => waitKeyPrefix(WORKFLOW, "a".repeat(65)), Error);
  assertEquals(
    waitKeyPrefix(WORKFLOW, "a".repeat(64)).endsWith(`${"a".repeat(64)}/`),
    true,
  );
  for (const generation of [0, -1, 1.5, Number.NaN]) {
    assertThrows(
      () => waitKeyRecordKey({ workflowId: WORKFLOW, key: "a", generation }),
      Error,
      "generation",
    );
  }
});

Deno.test("waitKeyAddressFromKey: a key of another family or shape names no record", () => {
  for (
    const storeKey of [
      "waits/wf/a/1",
      "wait-keys/wf/a",
      "wait-keys/wf/a/b/1",
      "wait-keys/wf/a/0",
      "wait-keys/wf/a/01",
      "wait-keys/wf/A/1",
      "wait-keys/../a/1",
      "wait-keys//a/1",
    ]
  ) {
    assertEquals(waitKeyAddressFromKey(storeKey), undefined, storeKey);
  }
});

Deno.test("decodeWaitKeyRecord: a record is absent, found under its own address, or unreadable", () => {
  const claim = claimOf();
  const bytes = encodeWaitKeyRecord(claim);
  assertEquals(decodeWaitKeyRecord(null, claim), { kind: "absent" });
  assertEquals(decodeWaitKeyRecord(bytes, claim), {
    kind: "found",
    record: claim,
  });
  // Stored under another generation, key or workflow than it names.
  for (
    const expected of [
      { ...claim, generation: 2 },
      { ...claim, key: "other" },
      { ...claim, workflowId: "wf-other" },
    ]
  ) {
    assertEquals(decodeWaitKeyRecord(bytes, expected).kind, "unreadable");
  }
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  for (
    const damaged of [
      new TextEncoder().encode("{"),
      encode({ ...claim, kind: "other" }),
      encode({ ...claim, waitId: "not-a-uuid" }),
      encode({ ...claim, key: "../escape" }),
      encode({ ...claim, workflowId: "a/b" }),
      encode({ ...claim, stepName: "x".repeat(WAIT_KEY_RECORD_MAX_BYTES) }),
    ]
  ) {
    assertEquals(decodeWaitKeyRecord(damaged, claim).kind, "unreadable");
  }
});

Deno.test("decideKeyHolder: only a highest claim whose wait has no outcome holds the key", () => {
  const claim = claimOf();
  assertEquals(decideKeyHolder(undefined, { kind: "absent" }), {
    held: false,
  });
  assertEquals(decideKeyHolder(claim, { kind: "absent" }), {
    held: true,
    claim,
  });
  assertEquals(
    decideKeyHolder(claim, { kind: "found", record: cancelled(claim) }),
    { held: false },
  );
  // An outcome that cannot be read is still an outcome: written once, it
  // leaves the wait unable to take a signal.
  assertEquals(decideKeyHolder(claim, { kind: "unreadable" }), {
    held: false,
  });
  assertEquals(
    decideKeyHolder({
      kind: "release",
      workflowId: WORKFLOW,
      key: "verdict",
      generation: 2,
      recordedAt: NOW.toISOString(),
    }, { kind: "absent" }),
    { held: false },
  );
});

Deno.test("claimWaitKey: the first wait takes a free key as generation 1", async () => {
  const store = new InMemorySignalWaitStore();
  const asked = request();
  const result = await claimWaitKey(store, asked, NOW);
  assert(result.kind === "acquired");
  assertEquals(result.claim, {
    kind: "claim",
    ...asked,
    generation: 1,
    recordedAt: NOW.toISOString(),
  });
  assertEquals(await store.listKeyRecords(), [result.claim]);
});

Deno.test("claimWaitKey: a second wait finds the key held, and creates nothing", async () => {
  const store = new InMemorySignalWaitStore();
  const holder = await acquire(store);
  const result = await claimWaitKey(store, request(), NOW);
  assertEquals(result, { kind: "held", claim: holder });
  assertEquals((await store.listKeyRecords()).length, 1);
});

Deno.test("claimWaitKey: keys of other names and of other workflows are held apart", async () => {
  const store = new InMemorySignalWaitStore();
  await acquire(store);
  assertEquals((await acquire(store, { key: "other" })).generation, 1);
  assertEquals((await acquire(store, { workflowId: "wf-2" })).generation, 1);
});

Deno.test("claimWaitKey: any outcome of the holder's wait frees the key for the next generation", async () => {
  const store = new InMemorySignalWaitStore();
  let holder = await acquire(store);
  for (const settle of ["cancelled", "damaged"] as const) {
    if (settle === "cancelled") await store.settle(cancelled(holder));
    else store.outcomes.set(holder.waitId, new TextEncoder().encode("{"));
    const next = await acquire(store);
    assertEquals(next.generation, holder.generation + 1);
    holder = next;
  }
});

Deno.test("claimWaitKey: a claimant settles an overdue holder as timed out first", async () => {
  const store = new InMemorySignalWaitStore();
  const holder = await acquire(store);
  const next = await acquire(
    store,
    { deadline: "2026-01-02T00:00:00.000Z" },
    PAST_DEADLINE,
  );
  assertEquals(next.generation, 2);
  const outcome = await store.findOutcome(holder.waitId);
  assert(outcome.kind === "found");
  assertEquals(outcome.record.kind, "timed_out");
  assertEquals(outcome.record.runId, holder.runId);
});

Deno.test("claimWaitKey: the step that holds the key through an open wait is told the claim is its own", async () => {
  const store = new InMemorySignalWaitStore();
  const asked = request();
  const holder = await acquire(store, asked);
  // The same step of the same run asks again with a new wait id.
  const again = await claimWaitKey(
    store,
    { ...asked, waitId: crypto.randomUUID() },
    NOW,
  );
  assertEquals(again, { kind: "own", claim: holder });
  // Another step of the same run is not the holder.
  const sibling = await claimWaitKey(
    store,
    { ...asked, waitId: crypto.randomUUID(), stepName: "other" },
    NOW,
  );
  assertEquals(sibling.kind, "held");
  // Once that wait is settled the step claims anew, like anyone else.
  await store.settle(cancelled(holder));
  assertEquals((await acquire(store, asked)).generation, 2);
});

Deno.test("claimWaitKey: a highest record that cannot be read leaves the holder unknown, and nothing is created over it", async () => {
  const store = new InMemorySignalWaitStore();
  const holder = await acquire(store);
  store.keyRecords.set(waitKeyRecordKey(holder), new TextEncoder().encode("{"));
  const result = await claimWaitKey(store, request(), NOW);
  assertEquals(result, { kind: "unreadable", generation: 1 });
  assertEquals(store.keyRecords.size, 1);
});

Deno.test("claimWaitKey: a claimant that loses its create to another wait finds the key held by the winner", async () => {
  // The store answers the first read as it stood before the rival claimed.
  class Raced extends InMemorySignalWaitStore {
    rival: WaitKeyClaim | undefined;
    override async highestKeyRecord(workflowId: string, key: string) {
      const before = await super.highestKeyRecord(workflowId, key);
      if (this.rival === undefined) {
        this.rival = claimOf();
        await super.createKeyRecord(this.rival);
      }
      return before;
    }
  }
  const store = new Raced();
  const result = await claimWaitKey(store, request(), NOW);
  assertEquals(result, { kind: "held", claim: store.rival! });
  assertEquals(store.keyRecords.size, 1);
});

Deno.test("claimWaitKey: gives up as contended when every create is lost to a claim settled at once", async () => {
  class AlwaysBeaten extends InMemorySignalWaitStore {
    override async highestKeyRecord(workflowId: string, key: string) {
      const before = await super.highestKeyRecord(workflowId, key);
      const generation = before.kind === "found"
        ? before.record.generation + 1
        : 1;
      const rival = claimOf({ generation });
      await super.createKeyRecord(rival);
      await this.settle(cancelled(rival));
      return before;
    }
  }
  const result = await claimWaitKey(new AlwaysBeaten(), request(), NOW);
  assertEquals(result.kind, "contended");
});

Deno.test("waitKeyRefusal: says who holds the key, or why nothing could be claimed", () => {
  const claim = claimOf();
  assertEquals(
    waitKeyRefusal("verdict", { kind: "held", claim }),
    `key verdict is held by the open wait ${claim.waitId} of step review in run ${claim.runId}`,
  );
  assert(
    waitKeyRefusal("verdict", { kind: "unreadable", generation: 3 })
      .includes("record 3 of key verdict cannot be read"),
  );
  assert(
    waitKeyRefusal("verdict", { kind: "contended" }).includes("in a row"),
  );
});

Deno.test("releaseKeyClaims: a highest claim is superseded by a release before it is removed, so its number is not used again", async () => {
  const store = new InMemorySignalWaitStore();
  const holder = await acquire(store);
  await store.settle(cancelled(holder));

  const done = await releaseKeyClaims(
    store,
    (claim) => claim.runId === holder.runId,
    NOW,
  );

  assertEquals(done, { removed: 1, released: 1 });
  const records = await store.listKeyRecords();
  assertEquals(records.map((r) => [r.kind, r.generation]), [["release", 2]]);
  // With the outcome gone too, the key still reads as free.
  await store.removeOutcome(holder.waitId);
  assertEquals((await acquire(store)).generation, 3);
});

Deno.test("releaseKeyClaims: a claim below the highest is removed with no release, and an unselected claim is kept", async () => {
  const store = new InMemorySignalWaitStore();
  const old = await acquire(store);
  await store.settle(cancelled(old));
  const holder = await acquire(store);

  const done = await releaseKeyClaims(
    store,
    (claim) => claim.runId === old.runId,
    NOW,
  );

  assertEquals(done, { removed: 1, released: 0 });
  assertEquals(await store.listKeyRecords(), [holder]);
});

Deno.test("releaseKeyClaims: a release a later claim superseded is removed, and the highest release is kept", async () => {
  const store = new InMemorySignalWaitStore();
  const first = await acquire(store);
  await store.settle(cancelled(first));
  await releaseKeyClaims(store, (c) => c.runId === first.runId, NOW);
  const second = await acquire(store);
  assertEquals(second.generation, 3);

  // Nothing is selected; the pass still drops the superseded release.
  assertEquals(await releaseKeyClaims(store, () => false, NOW), {
    removed: 1,
    released: 0,
  });
  assertEquals(await store.listKeyRecords(), [second]);

  await store.settle(cancelled(second));
  await releaseKeyClaims(store, (c) => c.runId === second.runId, NOW);
  assertEquals(await releaseKeyClaims(store, () => false, NOW), {
    removed: 0,
    released: 0,
  });
  assertEquals(
    (await store.listKeyRecords()).map((r) => [r.kind, r.generation]),
    [["release", 4]],
  );
});

Deno.test("releaseKeyClaims: a key whose highest record cannot be read is left as it is", async () => {
  const store = new InMemorySignalWaitStore();
  const old = await acquire(store);
  await store.settle(cancelled(old));
  const holder = await acquire(store);
  store.keyRecords.set(waitKeyRecordKey(holder), new TextEncoder().encode("{"));

  assertEquals(await releaseKeyClaims(store, () => true, NOW), {
    removed: 0,
    released: 0,
  });
  assertEquals(store.keyRecords.size, 2);
});

// A claim whose wait was never registered, or whose records went without it.

const AGED = new Date(NOW.getTime() + WAIT_KEY_UNREGISTERED_GRACE_MS + 1);

Deno.test("claimWaitKey: a claim with no registration holds the key through the grace period, and not a moment longer", async () => {
  const store = new InMemorySignalWaitStore();
  const holder = await acquire(store);
  const atTheLimit = new Date(NOW.getTime() + WAIT_KEY_UNREGISTERED_GRACE_MS);

  assertEquals(await claimWaitKey(store, request(), atTheLimit), {
    kind: "held",
    claim: holder,
  });
  assertEquals((await store.findOutcome(holder.waitId)).kind, "absent");

  const next = await acquire(store, {}, AGED);
  assertEquals(next.generation, 2);
  // The abandoned wait is closed with an outcome, so it can take no signal
  // if its step registers it after all.
  const outcome = await store.findOutcome(holder.waitId);
  assert(outcome.kind === "found");
  assertEquals(outcome.record.kind, "cancelled");
  assertEquals(outcome.record.runId, holder.runId);
});

Deno.test("claimWaitKey: an aged claim whose wait is registered, or whose registration cannot be read, still holds the key", async () => {
  for (const registration of ["registered", "damaged"] as const) {
    const store = new InMemorySignalWaitStore();
    const asked = request();
    const holder = await acquire(store, asked);
    if (registration === "registered") {
      await store.register({
        ...registrationOf(
          {
            workflowId: WORKFLOW,
            workflowName: "release",
            runId: asked.runId,
            jobName: "main",
            stepName: "review",
          },
          SignalWait.open({ type: "object" }, 3600, NOW, undefined, "verdict"),
          NOW,
        ),
        waitId: asked.waitId,
      });
    } else {
      store.registrations.set(asked.waitId, new TextEncoder().encode("{"));
    }

    assertEquals(
      await claimWaitKey(store, request(), AGED),
      { kind: "held", claim: holder },
      registration,
    );
    assertEquals((await store.findOutcome(holder.waitId)).kind, "absent");
  }
});

Deno.test("claimWaitKey: the step that made an aged, unregistered claim still takes its own wait over", async () => {
  const store = new InMemorySignalWaitStore();
  const asked = request();
  const holder = await acquire(store, asked);
  assertEquals(
    await claimWaitKey(
      store,
      { ...asked, waitId: crypto.randomUUID() },
      AGED,
    ),
    { kind: "own", claim: holder },
  );
  assertEquals((await store.findOutcome(holder.waitId)).kind, "absent");
});

Deno.test("waitKeyPrefix: a Windows device name is not a key", () => {
  for (const key of ["con", "nul", "com1", "lpt9"]) {
    assertThrows(() => waitKeyPrefix(WORKFLOW, key), Error, "wait key");
  }
  assertEquals(waitKeyAddressFromKey("wait-keys/wf/nul/1"), undefined);
});

Deno.test("findKeyHolder: a key with no record, or whose highest record is a release, is free", async () => {
  const store = new InMemorySignalWaitStore();
  assertEquals(await findKeyHolder(store, WORKFLOW, "verdict"), {
    kind: "free",
  });
  const claim = await acquire(store);
  await releaseKeyClaims(store, () => true, NOW);
  const highest = await store.highestKeyRecord(WORKFLOW, "verdict");
  assert(highest.kind === "found" && highest.record.kind === "release");
  assertEquals(await findKeyHolder(store, WORKFLOW, claim.key), {
    kind: "free",
  });
});

Deno.test("findKeyHolder: names the claim of the open wait, and only under its own workflow and key", async () => {
  const store = new InMemorySignalWaitStore();
  const claim = await acquire(store);
  assertEquals(await findKeyHolder(store, WORKFLOW, "verdict"), {
    kind: "held",
    claim,
  });
  assertEquals(await findKeyHolder(store, "wf-other", "verdict"), {
    kind: "free",
  });
  assertEquals(await findKeyHolder(store, WORKFLOW, "other"), {
    kind: "free",
  });
});

Deno.test("findKeyHolder: a holder past its deadline is still named, and nothing is settled", async () => {
  const store = new InMemorySignalWaitStore();
  const claim = await acquire(store);
  // The lookup takes no clock: it cannot settle, whatever the time is.
  assertEquals(await findKeyHolder(store, WORKFLOW, "verdict"), {
    kind: "held",
    claim,
  });
  assertEquals(store.outcomes.size, 0);
  // A claimant at that time settles it, and the key then reads as free.
  await claimWaitKey(store, request(), PAST_DEADLINE);
  assertEquals(store.outcomes.has(claim.waitId), true);
});

Deno.test("findKeyHolder: a claim whose wait has an outcome is free, also when the outcome names another run", async () => {
  const store = new InMemorySignalWaitStore();
  const claim = await acquire(store);
  await store.settle(cancelled(claim));
  assertEquals(await findKeyHolder(store, WORKFLOW, "verdict"), {
    kind: "free",
  });

  const other = new InMemorySignalWaitStore();
  const second = await acquire(other);
  await other.settle(
    cancelled({ ...second, runId: crypto.randomUUID() }),
  );
  assertEquals(await findKeyHolder(other, WORKFLOW, "verdict"), {
    kind: "free",
  });
});

Deno.test("findKeyHolder: a highest record that cannot be read leaves the holder unknown", async () => {
  const store = new InMemorySignalWaitStore();
  const claim = await acquire(store);
  store.keyRecords.set(
    waitKeyRecordKey(claim),
    new TextEncoder().encode("{not json"),
  );
  assertEquals(await findKeyHolder(store, WORKFLOW, "verdict"), {
    kind: "unreadable",
    generation: 1,
  });
});

Deno.test("findKeyHolder: a claim superseded between the two reads is not named as an open wait", async () => {
  const store = new InMemorySignalWaitStore();
  const claim = await acquire(store);
  // The claim's run is collected after the first read: a release takes the
  // next generation, then the outcome goes.
  let reads = 0;
  const racing = {
    highestKeyRecord: async (workflowId: string, key: string) => {
      const highest = await store.highestKeyRecord(workflowId, key);
      if (++reads === 1) {
        await store.settle(cancelled(claim));
        await releaseKeyClaims(store, () => true, NOW);
        await store.removeOutcome(claim.waitId);
      }
      return highest;
    },
    findOutcome: (waitId: string) => store.findOutcome(waitId),
  };
  assertEquals(await findKeyHolder(racing, WORKFLOW, "verdict"), {
    kind: "free",
  });
  assertEquals(reads, 2);
});

Deno.test("findKeyHolder: a workflow id or a key no record can be kept under holds nothing and is not looked up", async () => {
  const never = {
    highestKeyRecord: () => {
      throw new Error("the store was asked");
    },
    findOutcome: () => {
      throw new Error("the store was asked");
    },
  };
  for (const workflowId of ["", "..", "a/b", "a\\b"]) {
    assertEquals(await findKeyHolder(never, workflowId, "verdict"), {
      kind: "free",
    });
  }
  for (const key of ["", "Verdict", "../x", "con"]) {
    assertEquals(await findKeyHolder(never, WORKFLOW, key), { kind: "free" });
  }
});

Deno.test("declaredWaitKeyStep: names the step that declares the key, in any job, and nothing for another key", () => {
  const workflow = Workflow.create({
    name: "release",
    jobs: [
      Job.create({
        name: "build",
        steps: [
          Step.create({
            name: "compile",
            task: StepTask.model("builder", "run"),
          }),
          Step.create({
            name: "plain",
            task: StepTask.waitForSignal(60, { type: "object" }),
          }),
        ],
      }),
      Job.create({
        name: "gate",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(60, { type: "object" }, "verdict"),
          }),
        ],
      }),
    ],
  });
  assertEquals(declaredWaitKeyStep(workflow, "verdict"), {
    jobName: "gate",
    stepName: "review",
  });
  assertEquals(declaredWaitKeyStep(workflow, "other"), undefined);
  assertEquals(declaredWaitKeyStep(workflow, ""), undefined);
});

Deno.test("findSettledKeyHolder: names the wait that last held a key only while its settled claim is the highest record", async () => {
  const store = new InMemorySignalWaitStore();
  assertEquals(
    await findSettledKeyHolder(store, WORKFLOW, "verdict"),
    undefined,
  );

  // An open holder is not a settled one.
  const claim = await acquire(store);
  assertEquals(
    await findSettledKeyHolder(store, WORKFLOW, claim.key),
    undefined,
  );

  await store.settle(cancelled(claim));
  const settled = await findSettledKeyHolder(store, WORKFLOW, claim.key);
  assertEquals(settled?.claim.waitId, claim.waitId);
  assertEquals(settled?.outcome.kind, "cancelled");
  // The key is free all the while: this says who held it, not who holds it.
  assertEquals(await findKeyHolder(store, WORKFLOW, claim.key), {
    kind: "free",
  });

  // Once the claim is released with its run, nothing is said of it.
  await releaseKeyClaims(store, () => true, NOW);
  assertEquals(
    await findSettledKeyHolder(store, WORKFLOW, claim.key),
    undefined,
  );
});

Deno.test("findSettledKeyHolder: a workflow id or a key no record can be kept under names nothing", async () => {
  const store = new InMemorySignalWaitStore();
  for (
    const [workflowId, key] of [["../wf", "verdict"], [WORKFLOW, "Not A Key"]]
  ) {
    assertEquals(await findSettledKeyHolder(store, workflowId, key), undefined);
  }
});

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

import { assert, assertEquals } from "@std/assert";
import type { InputsSchema } from "../definitions/definition.ts";
import {
  decideEarlySignal,
  declaredEarlyWait,
  type EarlySignal,
  findSignalByIdempotencyKey,
  holdEarlySignal,
  listHeldPendingSignals,
  liveSlotsOf,
  validateEarlyPayload,
} from "./early_signal.ts";
import { Job } from "./job.ts";
import {
  earlyWaitRef,
  pendingRecordKey,
  type PendingSignal,
  takePendingSignal,
} from "./pending_signal.ts";
import { SignalWait } from "./signal_wait.ts";
import {
  cancelledOutcome,
  decideSignal,
  registrationOf,
} from "./signal_wait_records.ts";
import { InMemorySignalWaitStore } from "./signal_wait_store_test_helpers.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import {
  claimWaitKey,
  releaseKeyClaims,
  type WaitKeyClaim,
  waitKeyRecordKey,
  waitRefOfClaim,
} from "./wait_key_claim.ts";
import { Workflow } from "./workflow.ts";

const WORKFLOW = "wf-kitchen";
const KEY = "kitchen-verdict";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const WITHIN = new Date("2026-01-01T00:00:05.000Z");
const AFTER_LIMIT = new Date("2026-01-01T00:00:10.001Z");
const SCHEMA: InputsSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["known", "intruder"] } },
};

function signal(overrides: Partial<EarlySignal> = {}): EarlySignal {
  return {
    workflowId: WORKFLOW,
    key: KEY,
    payload: { verdict: "known" },
    submittedBy: "camera",
    acceptEarly: 10,
    ...overrides,
  };
}

/** A step of `runId` claims the key at `at`, as the executor does. */
async function claim(
  store: InMemorySignalWaitStore,
  at: Date,
  options: { runId?: string; register?: boolean } = {},
): Promise<{ claim: WaitKeyClaim; wait: SignalWait }> {
  let wait = SignalWait.open(SCHEMA, 30, at, undefined, KEY);
  const runId = options.runId ?? crypto.randomUUID();
  const acquired = await claimWaitKey(store, {
    workflowId: WORKFLOW,
    key: KEY,
    waitId: wait.id,
    runId,
    jobName: "main",
    stepName: "identify",
    deadline: wait.deadline.toISOString(),
    acceptEarly: 10,
  }, at);
  assert(acquired.kind === "acquired", `got ${acquired.kind}`);
  wait = wait.withEarly(acquired.claim.early!);
  if (options.register !== false) {
    await store.register(registrationOf(
      {
        workflowId: WORKFLOW,
        workflowName: "kitchen",
        runId,
        jobName: "main",
        stepName: "identify",
      },
      wait,
      at,
    ));
  }
  return { claim: acquired.claim, wait };
}

/** `store`, running `then` once, straight after the first pending create. */
function afterFirstCreate(
  store: InMemorySignalWaitStore,
  then: () => Promise<void>,
): InMemorySignalWaitStore {
  let first = true;
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "createPendingRecord") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (record: PendingSignal) => {
        const stored = await target.createPendingRecord(record);
        if (first) {
          first = false;
          await then();
        }
        return stored;
      };
    },
  });
}

Deno.test("declaredEarlyWait: finds the step that declares the key with acceptEarly", () => {
  const workflow = (acceptEarly?: number) =>
    Workflow.create({
      name: "kitchen",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "identify",
              task: StepTask.waitForSignal(30, SCHEMA, KEY, acceptEarly),
            }),
          ],
        }),
      ],
    });
  assertEquals(declaredEarlyWait(workflow(10), KEY), {
    jobName: "main",
    stepName: "identify",
    acceptEarly: 10,
    schema: SCHEMA,
  });
  assertEquals(declaredEarlyWait(workflow(10), "other"), undefined);
  assertEquals(declaredEarlyWait(workflow(), KEY), undefined);
});

Deno.test("validateEarlyPayload: the definition's schema and the limits of any payload apply", () => {
  assertEquals(validateEarlyPayload(SCHEMA, { verdict: "known" }, NOW), {
    valid: true,
    payload: { verdict: "known" },
  });
  assertEquals(
    validateEarlyPayload(SCHEMA, { verdict: "maybe" }, NOW).valid,
    false,
  );
  assertEquals(validateEarlyPayload(SCHEMA, "known", NOW).valid, false);
  assertEquals(
    validateEarlyPayload({ type: "object" }, { x: "y".repeat(20_000) }, NOW)
      .valid,
    false,
  );
});

Deno.test("liveSlotsOf: the slot is the next generation, and a release leaves its own slot live too", () => {
  assertEquals(liveSlotsOf({ kind: "none" }), { slot: 1, live: [1] });
  const address = {
    workflowId: WORKFLOW,
    key: KEY,
    generation: 4,
    recordedAt: NOW.toISOString(),
  };
  assertEquals(
    liveSlotsOf({ kind: "found", record: { kind: "release", ...address } }),
    { slot: 5, live: [5, 4] },
  );
  assertEquals(
    liveSlotsOf({
      kind: "found",
      record: {
        kind: "claim",
        ...address,
        waitId: "11111111-1111-4111-8111-111111111111",
        runId: "22222222-2222-4222-8222-222222222222",
        jobName: "main",
        stepName: "identify",
        deadline: NOW.toISOString(),
      },
    }),
    { slot: 5, live: [5] },
  );
});

Deno.test("decideEarlySignal: the first is stored, a second is refused while the first is held, and stored over it once it is not", () => {
  const held: PendingSignal = {
    kind: "pending",
    workflowId: WORKFLOW,
    key: KEY,
    slot: 1,
    number: 3,
    receiptId: "33333333-3333-4333-8333-333333333333",
    receivedAt: NOW.toISOString(),
    submittedBy: "camera",
    payload: {},
    acceptEarly: 10,
  };
  assertEquals(decideEarlySignal([{ kind: "none" }], NOW), {
    kind: "store",
    number: 1,
  });
  assertEquals(
    decideEarlySignal([{ kind: "found", record: held }], WITHIN),
    { kind: "already_pending", record: held },
  );
  assertEquals(
    decideEarlySignal([{ kind: "found", record: held }], AFTER_LIMIT),
    { kind: "store", number: 4 },
  );
  // A signal in the slot below, which a release left live, counts too.
  assertEquals(
    decideEarlySignal(
      [{ kind: "none" }, { kind: "found", record: { ...held, slot: 1 } }],
      WITHIN,
    ),
    { kind: "already_pending", record: held },
  );
  // A lapse supersedes a signal: the next one is stored above it.
  assertEquals(
    decideEarlySignal([{
      kind: "found",
      record: {
        kind: "lapse",
        workflowId: WORKFLOW,
        key: KEY,
        slot: 1,
        number: 2,
        recordedAt: NOW.toISOString(),
      },
    }], NOW),
    { kind: "store", number: 3 },
  );
  assertEquals(decideEarlySignal([{ kind: "unreadable", number: 2 }], NOW), {
    kind: "unreadable",
  });
});

Deno.test("holdEarlySignal: with no wait and nothing pending the signal is stored in the next claim's slot", async () => {
  const store = new InMemorySignalWaitStore();
  const arrival = await holdEarlySignal(store, signal(), NOW);
  assert(arrival.kind === "pending", `got ${arrival.kind}`);
  assertEquals(arrival.record.slot, 1);
  assertEquals(arrival.record.number, 1);
  assertEquals(arrival.record.receivedAt, NOW.toISOString());
  assertEquals(arrival.record.payload, { verdict: "known" });
  assertEquals(store.pendingRecords.size, 1);
  assertEquals(store.outcomes.size, 0);
  assertEquals(store.keyRecords.size, 0);
});

Deno.test("holdEarlySignal: a second early signal within the limit is refused with the first, and nothing more is stored", async () => {
  const store = new InMemorySignalWaitStore();
  const first = await holdEarlySignal(store, signal(), NOW);
  assert(first.kind === "pending");
  const second = await holdEarlySignal(
    store,
    signal({ payload: { verdict: "intruder" } }),
    WITHIN,
  );
  assertEquals(second, { kind: "already_pending", record: first.record });
  assertEquals(store.pendingRecords.size, 1);
});

Deno.test("holdEarlySignal: a signal past its age limit is superseded at the next number, never overwritten", async () => {
  const store = new InMemorySignalWaitStore();
  const first = await holdEarlySignal(store, signal(), NOW);
  assert(first.kind === "pending");
  const second = await holdEarlySignal(
    store,
    signal({ payload: { verdict: "intruder" } }),
    AFTER_LIMIT,
  );
  assert(second.kind === "pending", `got ${second.kind}`);
  assertEquals([second.record.slot, second.record.number], [1, 2]);
  assertEquals(store.pendingRecords.size, 2);
  assertEquals(await store.findPendingRecord(first.record), {
    kind: "found",
    record: first.record,
  });
});

Deno.test("holdEarlySignal: of two early signals at the same moment exactly one is stored", async () => {
  const store = new InMemorySignalWaitStore();
  // Both read the slot before either creates: the second read is staged as
  // empty, though the first signal is stored by then.
  const first = await holdEarlySignal(store, signal(), NOW);
  assert(first.kind === "pending");
  const readBeforeTheCreate = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "highestPendingRecord") {
        return () => Promise.resolve({ kind: "none" });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const second = await holdEarlySignal(
    readBeforeTheCreate,
    signal({ payload: { verdict: "intruder" } }),
    NOW,
  );
  assertEquals(second, { kind: "already_pending", record: first.record });
  assertEquals(store.pendingRecords.size, 1);
});

Deno.test("holdEarlySignal: a wait that holds the key is reported and nothing is stored", async () => {
  const store = new InMemorySignalWaitStore();
  const open = await claim(store, NOW);
  const arrival = await holdEarlySignal(store, signal(), WITHIN);
  assertEquals(arrival, { kind: "held", claim: open.claim });
  assertEquals(store.pendingRecords.size, 0);
});

Deno.test("holdEarlySignal: a step that claims between the create and the second read is found, with the stored signal in its slot", async () => {
  const store = new InMemorySignalWaitStore();
  let opened: WaitKeyClaim | undefined;
  const arrival = await holdEarlySignal(
    afterFirstCreate(store, async () => {
      opened = (await claim(store, NOW)).claim;
    }),
    signal(),
    NOW,
  );
  assert(arrival.kind === "held", `got ${arrival.kind}`);
  assertEquals(arrival.claim, opened);
  assertEquals(arrival.record?.slot, opened!.early!.generation);
  // The signaller, or any later reader, gives the wait that signal.
  const registration = await store.findRegistration(opened!.waitId);
  assert(registration.kind === "found");
  const taken = await takePendingSignal(
    store,
    earlyWaitRef(registration.record)!,
  );
  assert(taken.kind === "found" && taken.record.kind === "accepted");
  assertEquals(taken.record.receipt.id, arrival.record?.receiptId);
});

Deno.test("holdEarlySignal: a step that took the signal on opening is reported as having taken it", async () => {
  const store = new InMemorySignalWaitStore();
  let opened: WaitKeyClaim | undefined;
  const arrival = await holdEarlySignal(
    afterFirstCreate(store, async () => {
      const step = await claim(store, NOW);
      opened = step.claim;
      const registration = await store.findRegistration(step.claim.waitId);
      assert(registration.kind === "found");
      await takePendingSignal(store, earlyWaitRef(registration.record)!);
    }),
    signal(),
    NOW,
  );
  assert(arrival.kind === "taken", `got ${arrival.kind}`);
  assertEquals(arrival.claim, opened);
  const outcome = await store.findOutcome(opened!.waitId);
  assert(outcome.kind === "found" && outcome.record.kind === "accepted");
  assertEquals(outcome.record.receipt.id, arrival.record.receiptId);
});

Deno.test("holdEarlySignal: a signal a step took is not given to the wait a later run opened under the key", async () => {
  // The taker is below the key's highest record by then. It is found by its
  // slot, never by listing the key records of every workflow.
  const store = new class extends InMemorySignalWaitStore {
    override listKeyRecords(): Promise<never> {
      return Promise.reject(new Error("listed every key record"));
    }
  }();
  let taker: WaitKeyClaim | undefined;
  let later: WaitKeyClaim | undefined;
  const arrival = await holdEarlySignal(
    afterFirstCreate(store, async () => {
      const step = await claim(store, NOW);
      taker = step.claim;
      const registration = await store.findRegistration(step.claim.waitId);
      assert(registration.kind === "found");
      await takePendingSignal(store, earlyWaitRef(registration.record)!);
      // The key is free again, and a second run opens its wait.
      later = (await claim(store, NOW)).claim;
    }),
    signal(),
    NOW,
  );
  assert(arrival.kind === "taken", `got ${arrival.kind}`);
  assertEquals(arrival.claim, taker);
  assertEquals((await store.findOutcome(later!.waitId)).kind, "absent");
});

Deno.test("holdEarlySignal: a signal a step took is not stored again when the key was claimed and settled since", async () => {
  const store = new InMemorySignalWaitStore();
  let taker: WaitKeyClaim | undefined;
  const arrival = await holdEarlySignal(
    afterFirstCreate(store, async () => {
      const step = await claim(store, NOW);
      taker = step.claim;
      const registration = await store.findRegistration(step.claim.waitId);
      assert(registration.kind === "found");
      await takePendingSignal(store, earlyWaitRef(registration.record)!);
      const second = await claim(store, NOW);
      await store.settle(cancelledOutcome(waitRefOfClaim(second.claim), NOW));
    }),
    signal(),
    NOW,
  );
  assert(arrival.kind === "taken", `got ${arrival.kind}`);
  assertEquals(arrival.claim, taker);
  assertEquals(store.pendingRecords.size, 1);
});

Deno.test("holdEarlySignal: a step that takes the signal between the signaller's reads of its outcome does not have it stored again", async () => {
  // The step has claimed and registered when the signaller reads the key
  // again, and takes the signal straight after the signaller's first or
  // second read of the claim's outcome.
  for (const afterRead of [1, 2]) {
    const store = new InMemorySignalWaitStore();
    let opened: WaitKeyClaim | undefined;
    let reads = 0;
    const racing = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "createPendingRecord") {
          return async (record: PendingSignal) => {
            const stored = await target.createPendingRecord(record);
            opened ??= (await claim(target, NOW)).claim;
            return stored;
          };
        }
        if (property === "findOutcome") {
          return async (waitId: string) => {
            const found = await target.findOutcome(waitId);
            if (++reads === afterRead) {
              const registration = await target.findRegistration(
                opened!.waitId,
              );
              assert(registration.kind === "found");
              await takePendingSignal(
                target,
                earlyWaitRef(registration.record)!,
              );
            }
            return found;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const arrival = await holdEarlySignal(racing, signal(), NOW);
    assert(
      arrival.kind === "taken" || arrival.kind === "held",
      `got ${arrival.kind} after read ${afterRead}`,
    );
    assertEquals(arrival.claim, opened);
    // One record, and the wait's outcome is that signal.
    assertEquals(store.pendingRecords.size, 1);
    const outcome = await store.findOutcome(opened!.waitId);
    assert(outcome.kind === "found" && outcome.record.kind === "accepted");
    assertEquals(outcome.record.receipt.id, arrival.record?.receiptId);
  }
});

Deno.test("holdEarlySignal: a wait opened under a later claim is reported, though the signal sits in a slot it does not read", async () => {
  const store = new InMemorySignalWaitStore();
  let second: WaitKeyClaim | undefined;
  const arrival = await holdEarlySignal(
    afterFirstCreate(store, async () => {
      // The claim of the signal's slot is made and its wait closed at once;
      // a second run then claims the key.
      const first = await claim(store, NOW);
      await store.settle(cancelledOutcome(waitRefOfClaim(first.claim), NOW));
      second = (await claim(store, NOW)).claim;
    }),
    signal(),
    NOW,
  );
  assert(arrival.kind === "held", `got ${arrival.kind}`);
  assertEquals(arrival.claim, second);
  assertEquals(arrival.claim.generation, 2);
  assertEquals(arrival.record?.slot, 1);
  // That wait reads slot 2 and takes nothing from slot 1.
  const registration = await store.findRegistration(second!.waitId);
  assert(registration.kind === "found");
  assertEquals(
    await takePendingSignal(store, earlyWaitRef(registration.record)!),
    { kind: "absent" },
  );
});

Deno.test("holdEarlySignal: when its slot was claimed and settled with the key free, the signal arrives again at the next slot", async () => {
  const store = new InMemorySignalWaitStore();
  const arrival = await holdEarlySignal(
    afterFirstCreate(store, async () => {
      // Claimed before the signal's window: the claim does not take it.
      const first = await claim(store, new Date(NOW.getTime() + 60_000));
      await store.settle(cancelledOutcome(waitRefOfClaim(first.claim), NOW));
    }),
    signal(),
    NOW,
  );
  assert(arrival.kind === "pending", `got ${arrival.kind}`);
  assertEquals([arrival.record.slot, arrival.record.number], [2, 1]);
  // The same signal: one receipt, one received time.
  const [first, again] = [...store.pendingRecords.values()].map((bytes) =>
    JSON.parse(new TextDecoder().decode(bytes)) as PendingSignal
  );
  assertEquals(first.receiptId, again.receiptId);
  assertEquals(first.receivedAt, again.receivedAt);
});

Deno.test("holdEarlySignal: a release over the last claim leaves the signal's slot live, and the next signal sees it there", async () => {
  const store = new InMemorySignalWaitStore();
  const gone = await claim(store, NOW);
  await store.settle(cancelledOutcome(waitRefOfClaim(gone.claim), NOW));
  // The signal reads claim 1 and is stored in slot 2; the run is then
  // deleted and a release takes generation 2.
  const arrival = await holdEarlySignal(
    afterFirstCreate(store, async () => {
      await releaseKeyClaims(store, () => true, NOW);
    }),
    signal(),
    NOW,
  );
  assert(arrival.kind === "pending", `got ${arrival.kind}`);
  assertEquals(arrival.record.slot, 2);
  // A second signal reads the release, would store in slot 3, and finds
  // the first in slot 2.
  const second = await holdEarlySignal(store, signal(), WITHIN);
  assertEquals(second, { kind: "already_pending", record: arrival.record });
  // The next claim is made over the release and reads both slots.
  const next = await claim(store, WITHIN);
  assertEquals(next.claim.early?.overRelease, true);
  const registration = await store.findRegistration(next.claim.waitId);
  assert(registration.kind === "found");
  const taken = await takePendingSignal(
    store,
    earlyWaitRef(registration.record)!,
  );
  assert(taken.kind === "found" && taken.record.kind === "accepted");
  assertEquals(taken.record.receipt.id, arrival.record.receiptId);
});

Deno.test("holdEarlySignal: a key whose highest record cannot be read holds nothing", async () => {
  const store = new InMemorySignalWaitStore();
  store.keyRecords.set(
    waitKeyRecordKey({ workflowId: WORKFLOW, key: KEY, generation: 1 }),
    new TextEncoder().encode("{"),
  );
  assertEquals(await holdEarlySignal(store, signal(), NOW), {
    kind: "unreadable",
  });
  assertEquals(store.pendingRecords.size, 0);
});

Deno.test("findSignalByIdempotencyKey: finds the held signal while it is within its age limit, and only under its own key", async () => {
  const store = new InMemorySignalWaitStore();
  const at = { workflowId: WORKFLOW, key: KEY };
  assertEquals(
    await findSignalByIdempotencyKey(store, at, {
      idempotencyKey: "order-1",
      submittedBy: "camera",
    }, NOW),
    undefined,
  );
  const held = await holdEarlySignal(
    store,
    signal({ idempotencyKey: "order-1" }),
    NOW,
  );
  assert(held.kind === "pending");
  assertEquals(held.record.idempotencyKey, "order-1");
  assertEquals(
    await findSignalByIdempotencyKey(store, at, {
      idempotencyKey: "order-1",
      submittedBy: "camera",
    }, WITHIN),
    { kind: "pending", record: held.record },
  );
  assertEquals(
    await findSignalByIdempotencyKey(store, at, {
      idempotencyKey: "order-2",
      submittedBy: "camera",
    }, WITHIN),
    undefined,
  );
  // Past its limit no wait takes it, so a retry is not a repeat of it.
  assertEquals(
    await findSignalByIdempotencyKey(store, at, {
      idempotencyKey: "order-1",
      submittedBy: "camera",
    }, AFTER_LIMIT),
    undefined,
  );
});

Deno.test("findSignalByIdempotencyKey: finds the signal a wait took under the key's highest claim and the one below, and no further", async () => {
  const store = new InMemorySignalWaitStore();
  const at = { workflowId: WORKFLOW, key: KEY };
  const held = await holdEarlySignal(
    store,
    signal({ idempotencyKey: "order-1" }),
    NOW,
  );
  assert(held.kind === "pending");
  const first = await claim(store, WITHIN);
  const taken = await takePendingSignal(
    store,
    earlyWaitRef({ ...waitRefOfClaim(first.claim), schema: SCHEMA })!,
  );
  assert(taken.kind === "found" && taken.record.kind === "accepted");

  const found = await findSignalByIdempotencyKey(store, at, {
    idempotencyKey: "order-1",
    submittedBy: "camera",
  }, WITHIN);
  assert(found?.kind === "settled", `got ${found?.kind}`);
  assertEquals(found.claim.waitId, first.claim.waitId);
  assertEquals(found.outcome.receipt.id, held.record.receiptId);

  // The next run opens its wait: the claim below the highest still says so.
  const second = await claim(store, new Date(NOW.getTime() + 60_000));
  const below = await findSignalByIdempotencyKey(store, at, {
    idempotencyKey: "order-1",
    submittedBy: "camera",
  }, WITHIN);
  assert(below?.kind === "settled", `got ${below?.kind}`);
  assertEquals(below.claim.waitId, first.claim.waitId);

  // Two claims later the receipt is out of reach.
  await store.settle(
    cancelledOutcome(
      waitRefOfClaim(second.claim),
      new Date(NOW.getTime() + 61_000),
    ),
  );
  await claim(store, new Date(NOW.getTime() + 120_000));
  assertEquals(
    await findSignalByIdempotencyKey(store, at, {
      idempotencyKey: "order-1",
      submittedBy: "camera",
    }, WITHIN),
    undefined,
  );
});

Deno.test("findSignalByIdempotencyKey: a key names a signal of its sender only", async () => {
  const store = new InMemorySignalWaitStore();
  const at = { workflowId: WORKFLOW, key: KEY };
  const held = await holdEarlySignal(
    store,
    signal({ idempotencyKey: "order-1" }),
    NOW,
  );
  assert(held.kind === "pending");
  assertEquals(
    await findSignalByIdempotencyKey(
      store,
      at,
      { idempotencyKey: "order-1", submittedBy: "doorbell" },
      WITHIN,
    ),
    undefined,
  );
  const first = await claim(store, WITHIN);
  await takePendingSignal(
    store,
    earlyWaitRef({ ...waitRefOfClaim(first.claim), schema: SCHEMA })!,
  );
  assertEquals(
    await findSignalByIdempotencyKey(
      store,
      at,
      { idempotencyKey: "order-1", submittedBy: "doorbell" },
      WITHIN,
    ),
    undefined,
  );
});

Deno.test("holdEarlySignal: a signal whose other copy settled the wait that reads its slot is not stored again for the next claim", async () => {
  // A copy of the signal, from the same sender under the same key, is
  // delivered to the step's wait while this one arrives: the slot is
  // claimed and settled, by a receipt that is not this signal's.
  const settledBy = async (
    store: InMemorySignalWaitStore,
    sender: string,
    idempotencyKey: string,
  ) => {
    const step = await claim(store, NOW);
    const registration = await store.findRegistration(step.claim.waitId);
    assert(registration.kind === "found");
    const decision = decideSignal(
      registration.record,
      { verdict: "known" },
      sender,
      NOW,
      idempotencyKey,
    );
    assert(decision.accepted);
    await store.settle(decision.outcome);
    return { claim: step.claim, receipt: decision.outcome.receipt };
  };

  const store = new InMemorySignalWaitStore();
  let other: Awaited<ReturnType<typeof settledBy>> | undefined;
  const arrival = await holdEarlySignal(
    afterFirstCreate(store, async () => {
      other = await settledBy(store, "camera", "order-1");
    }),
    signal({ idempotencyKey: "order-1" }),
    NOW,
  );
  assert(arrival.kind === "duplicate", `got ${arrival.kind}`);
  assertEquals(arrival.claim, other?.claim);
  assertEquals(arrival.outcome.receipt, other?.receipt);
  // Only the record it stored before it found out; none in the next slot.
  assertEquals(
    (await store.listPendingAddresses()).map((at) => at.slot),
    [1],
  );

  // Another sender's signal, or another key, is a signal of its own.
  for (
    const [sender, key] of [["doorbell", "order-1"], ["camera", "order-2"]]
  ) {
    const separate = new InMemorySignalWaitStore();
    const held = await holdEarlySignal(
      afterFirstCreate(separate, async () => {
        await settledBy(separate, sender, key);
      }),
      signal({ idempotencyKey: "order-1" }),
      NOW,
    );
    assert(held.kind === "pending", `got ${held.kind}`);
    assertEquals(held.record.slot, 2);
  }
});

Deno.test("listHeldPendingSignals: lists a held signal by its receipt, without its payload, until its age limit ends", async () => {
  const store = new InMemorySignalWaitStore();
  const held = await holdEarlySignal(
    store,
    signal({ authorizedFor: "kitchen" }),
    NOW,
  );
  assert(held.kind === "pending");
  const expected = {
    workflowId: WORKFLOW,
    key: KEY,
    receiptId: held.record.receiptId,
    receivedAt: NOW.toISOString(),
    heldUntil: "2026-01-01T00:00:10.000Z",
    submittedBy: "camera",
    authorizedFor: "kitchen",
  };
  assertEquals(await listHeldPendingSignals(store, WITHIN), [expected]);
  assertEquals(await listHeldPendingSignals(store, AFTER_LIMIT), []);
});

Deno.test("listHeldPendingSignals: a signal a wait took, or one superseded by a lapse, is not listed", async () => {
  const store = new InMemorySignalWaitStore();
  const held = await holdEarlySignal(store, signal(), NOW);
  assert(held.kind === "pending");
  // The next claim takes it: its slot is no longer live.
  const { claim: taker } = await claim(store, WITHIN);
  const registration = await store.findRegistration(taker.waitId);
  assert(registration.kind === "found");
  await takePendingSignal(store, earlyWaitRef(registration.record)!);
  assertEquals(await listHeldPendingSignals(store, WITHIN), []);

  const other = new InMemorySignalWaitStore();
  const first = await holdEarlySignal(other, signal(), NOW);
  assert(first.kind === "pending");
  await other.createPendingRecord({
    kind: "lapse",
    workflowId: WORKFLOW,
    key: KEY,
    slot: first.record.slot,
    number: first.record.number + 1,
    recordedAt: NOW.toISOString(),
  });
  assertEquals(await listHeldPendingSignals(other, WITHIN), []);
});

Deno.test("listHeldPendingSignals: lists one signal per key, ordered by when each is held until", async () => {
  const store = new InMemorySignalWaitStore();
  const late = await holdEarlySignal(
    store,
    signal({ key: "late", acceptEarly: 60 }),
    NOW,
  );
  const soon = await holdEarlySignal(
    store,
    signal({ key: "soon", acceptEarly: 20 }),
    NOW,
  );
  assert(late.kind === "pending" && soon.kind === "pending");
  // A second signal for a held key is refused, so it adds nothing.
  await holdEarlySignal(store, signal({ key: "soon" }), WITHIN);
  assertEquals(
    (await listHeldPendingSignals(store, WITHIN)).map((each) => each.key),
    ["soon", "late"],
  );
});

Deno.test("listHeldPendingSignals: a key or a slot head that cannot be read is left out, and the rest is listed", async () => {
  const store = new InMemorySignalWaitStore();
  const readable = await holdEarlySignal(store, signal({ key: "fine" }), NOW);
  assert(readable.kind === "pending");
  const broken = await holdEarlySignal(store, signal({ key: "broken" }), NOW);
  assert(broken.kind === "pending");
  store.pendingRecords.set(
    pendingRecordKey(broken.record),
    new TextEncoder().encode("{"),
  );
  const keyless = await holdEarlySignal(store, signal({ key: "keyless" }), NOW);
  assert(keyless.kind === "pending");
  store.keyRecords.set(
    waitKeyRecordKey({ workflowId: WORKFLOW, key: "keyless", generation: 1 }),
    new TextEncoder().encode("{"),
  );
  assertEquals(
    (await listHeldPendingSignals(store, WITHIN)).map((each) => each.key),
    ["fine"],
  );
});

Deno.test("listHeldPendingSignals: a signal stored below a release is listed, as the next claim reads that slot", async () => {
  const store = new InMemorySignalWaitStore();
  const gone = await claim(store, NOW);
  await store.settle(cancelledOutcome(waitRefOfClaim(gone.claim), NOW));
  const arrival = await holdEarlySignal(
    afterFirstCreate(store, async () => {
      await releaseKeyClaims(store, () => true, NOW);
    }),
    signal(),
    NOW,
  );
  assert(arrival.kind === "pending");
  assertEquals(arrival.record.slot, 2);
  const listed = await listHeldPendingSignals(store, WITHIN);
  assertEquals(listed.map((each) => each.receiptId), [
    arrival.record.receiptId,
  ]);
});

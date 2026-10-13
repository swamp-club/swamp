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
import fc from "fast-check";
import {
  applicablePendingOutcome,
  decodePendingRecord,
  earliestReceipt,
  type EarlyWaitRef,
  earlyWaitRef,
  encodePendingRecord,
  isReceivedForWait,
  pendingAddressFromKey,
  pendingOutcome,
  type PendingRecord,
  pendingRecordKey,
  type PendingSignal,
  takePendingSignal,
} from "./pending_signal.ts";
import { Job } from "./job.ts";
import { isWaitKey, SignalWait, WAIT_KEY_PATTERN } from "./signal_wait.ts";
import {
  findUnsettledWait,
  outcomeAt,
  waitRefOf,
} from "./signal_wait_cleanup.ts";
import type { WaitOutcome } from "./signal_wait_records.ts";
import { InMemorySignalWaitStore } from "./signal_wait_store_test_helpers.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import { WorkflowRun } from "./workflow_run.ts";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

const keyArb = fc.stringMatching(WAIT_KEY_PATTERN).filter(isWaitKey);
const workflowIdArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/)
  .filter((id) => id !== "." && id !== "..");
const addressArb = {
  workflowId: workflowIdArb,
  key: keyArb,
  slot: fc.integer({ min: 1, max: 1_000_000 }),
  number: fc.integer({ min: 1, max: 1_000_000 }),
};
const payloadArb = fc.dictionary(
  fc.stringMatching(/^[a-z]{1,8}$/),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { maxKeys: 4 },
);
const pendingArb: fc.Arbitrary<PendingSignal> = fc.record({
  kind: fc.constant("pending" as const),
  ...addressArb,
  receiptId: fc.uuid(),
  receivedAt: fc.integer({ min: 0, max: 86_400_000 }).map(at),
  submittedBy: fc.string({ minLength: 1, maxLength: 32 }),
  payload: payloadArb,
  acceptEarly: fc.integer({ min: 1, max: 3600 }),
});
const recordArb: fc.Arbitrary<PendingRecord> = fc.oneof(
  pendingArb,
  fc.record({
    kind: fc.constant("lapse" as const),
    ...addressArb,
    recordedAt: fc.constant(at(0)),
  }),
);

Deno.test("pending record: any record survives its stored form and is found only under its own address (property)", () => {
  fc.assert(
    fc.property(recordArb, (record) => {
      const bytes = encodePendingRecord(record);
      assertEquals(decodePendingRecord(bytes, record), {
        kind: "found",
        record,
      });
      assertEquals(pendingAddressFromKey(pendingRecordKey(record)), {
        workflowId: record.workflowId,
        key: record.key,
        slot: record.slot,
        number: record.number,
      });
      assertEquals(
        decodePendingRecord(bytes, { ...record, number: record.number + 1 }),
        { kind: "unreadable" },
      );
    }),
  );
});

const WAIT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

/** A wait, a pending signal in its slot, and the times that decide between them. */
const settlingArb = fc.record({
  claimedAt: fc.integer({ min: 0, max: 3_600_000 }),
  acceptEarly: fc.integer({ min: 1, max: 3600 }),
  timeout: fc.integer({ min: 1, max: 3600 }),
  // Relative to the claim, from well before the limit to well after the
  // deadline.
  receivedOffset: fc.integer({ min: -4_000_000, max: 4_000_000 }),
  lookOffset: fc.integer({ min: 0, max: 8_000_000 }),
  // What settled the wait before anyone looked, if anything.
  earlier: fc.constantFrom("none", "timed_out", "cancelled"),
});

function scenario(s: {
  claimedAt: number;
  acceptEarly: number;
  timeout: number;
  receivedOffset: number;
}): { ref: EarlyWaitRef; pending: PendingSignal; applies: boolean } {
  const deadline = s.claimedAt + s.timeout * 1000;
  const received = s.claimedAt + s.receivedOffset;
  const ref: EarlyWaitRef = {
    waitId: WAIT_ID,
    workflowId: "wf",
    runId: RUN_ID,
    deadline: at(deadline),
    key: "k",
    early: {
      generation: 1,
      overRelease: false,
      from: earliestReceipt(new Date(BASE + s.claimedAt), s.acceptEarly),
    },
    schema: { type: "object" },
  };
  const pending: PendingSignal = {
    kind: "pending",
    workflowId: "wf",
    key: "k",
    slot: 1,
    number: 1,
    receiptId: "33333333-3333-4333-8333-333333333333",
    receivedAt: at(received),
    submittedBy: "camera",
    payload: { verdict: "known" },
    acceptEarly: s.acceptEarly,
  };
  return {
    ref,
    pending,
    applies: received >= s.claimedAt - s.acceptEarly * 1000 &&
      received <= deadline,
  };
}

Deno.test("pendingOutcome: a pending signal applies exactly when it was received between the claim minus the age limit and the deadline (property)", () => {
  fc.assert(
    fc.property(settlingArb, (s) => {
      const { ref, pending, applies } = scenario(s);
      assertEquals(pendingOutcome(pending, ref) !== undefined, applies);
    }),
  );
});

Deno.test("isReceivedForWait: a signal the claim's facts refuse is never taken by the wait, whatever its name, schema or payload (property)", () => {
  fc.assert(
    fc.property(
      settlingArb,
      fc.integer({ min: 1, max: 3 }),
      fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
      payloadArb,
      (s, slot, authorizedFor, payload) => {
        const { ref, pending } = scenario(s);
        const signal = {
          ...pending,
          slot,
          payload,
          ...(authorizedFor !== undefined ? { authorizedFor } : {}),
        };
        // What the claim keeps of the wait.
        const claim = { early: ref.early, deadline: ref.deadline };
        if (!isReceivedForWait(signal, claim)) {
          assertEquals(pendingOutcome(signal, ref), undefined);
        }
      },
    ),
  );
});

Deno.test("outcomeAt: the settling decision over the claim, the pending signal, the outcome and the time (property)", async () => {
  await fc.assert(
    fc.asyncProperty(settlingArb, async (s) => {
      const { ref, pending, applies } = scenario(s);
      const now = new Date(BASE + s.claimedAt + s.lookOffset);
      const store = new InMemorySignalWaitStore();
      await store.createPendingRecord(pending);
      if (s.earlier !== "none") {
        await store.settle(
          {
            kind: s.earlier,
            waitId: WAIT_ID,
            workflowId: "wf",
            runId: RUN_ID,
            deadline: ref.deadline,
            settledAt: ref.deadline,
          } as WaitOutcome,
        );
      }
      const stored = await outcomeAt(store, ref, now);
      const kind = stored.kind === "found" ? stored.record.kind : stored.kind;
      // An outcome is written once: what settled the wait first stands.
      // Otherwise an applicable pending signal is taken whenever the reader
      // looks, before or after the deadline; and only a wait with neither
      // times out, and only past its deadline.
      const expired = now.getTime() > new Date(ref.deadline).getTime();
      const expected = s.earlier !== "none"
        ? s.earlier
        : applies
        ? "accepted"
        : expired
        ? "timed_out"
        : "absent";
      assertEquals(kind, expected);
      // Every later reader agrees, whenever it looks.
      const later = await outcomeAt(store, ref, new Date(now.getTime() + 1e9));
      if (expected !== "absent") assertEquals(later, stored);
      // And taking again changes nothing.
      const again = await takePendingSignal(store, ref);
      if (expected === "accepted") assertEquals(again, stored);
    }),
  );
});

// The read-only check and the take built on it (swamp-club#3309). The slot
// states are generated apart from `settlingArb`, which the properties above
// keep as they were.

const STRICT_SCHEMA = {
  type: "object" as const,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["known"] } },
};
const OWN_RECEIPT = "33333333-3333-4333-8333-333333333333";
const BELOW_RECEIPT = "44444444-4444-4444-8444-444444444444";

/** A wait claimed at generation 2 and what its two slots may hold. */
const slotsArb = fc.record({
  claimedAt: fc.integer({ min: 0, max: 3_600_000 }),
  acceptEarly: fc.integer({ min: 1, max: 3600 }),
  timeout: fc.integer({ min: 1, max: 3600 }),
  receivedOffset: fc.integer({ min: -4_000_000, max: 4_000_000 }),
  // The highest record of the wait's own slot.
  head: fc.constantFrom("none", "pending", "lapse", "unreadable"),
  // Whether the schema the wait captured allows the own slot's payload.
  payloadAllowed: fc.boolean(),
  // The slot below, which only a claim created over a release reads.
  overRelease: fc.boolean(),
  below: fc.constantFrom("none", "pending"),
  earlier: fc.constantFrom("none", "timed_out", "cancelled"),
  // When a reader looks, in thousandths of the way from claim to deadline.
  lookPermille: fc.integer({ min: 0, max: 1000 }),
});
type Slots = typeof slotsArb extends fc.Arbitrary<infer T> ? T : never;

/** The wait of `s` as a step of a suspended run holds it. */
function waitingAt(s: Slots): { run: WorkflowRun; ref: EarlyWaitRef } {
  const workflow = Workflow.create({
    name: "kitchen",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "identify",
            task: StepTask.waitForSignal(3600, STRICT_SCHEMA, "k", 3600),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("identify")!;
  step.start();
  step.waitForSignal(SignalWait.fromData({
    kind: "signal",
    id: WAIT_ID,
    schema: STRICT_SCHEMA,
    deadline: at(s.claimedAt + s.timeout * 1000),
    key: "k",
    early: {
      generation: 2,
      overRelease: s.overRelease,
      from: earliestReceipt(new Date(BASE + s.claimedAt), s.acceptEarly),
    },
  }));
  run.suspend();
  const ref = earlyWaitRef(waitRefOf(run, step)!);
  if (!ref) throw new Error("the generated wait reads a slot");
  return { run, ref };
}

/**
 * A store holding what `s` describes, and the receipt of the signal the
 * wait is given, if any: its own slot's when that applies, else the slot
 * below's for a claim created over a release.
 */
async function storeOf(
  s: Slots,
  ref: EarlyWaitRef,
): Promise<{ store: InMemorySignalWaitStore; receipt: string | undefined }> {
  const store = new InMemorySignalWaitStore();
  const received = s.claimedAt + s.receivedOffset;
  const inWindow = received >= s.claimedAt - s.acceptEarly * 1000 &&
    received <= s.claimedAt + s.timeout * 1000;
  const signal = (
    slot: number,
    receiptId: string,
    verdict: unknown,
  ): PendingSignal => ({
    kind: "pending",
    workflowId: ref.workflowId,
    key: "k",
    slot,
    number: 1,
    receiptId,
    receivedAt: at(received),
    submittedBy: "camera",
    payload: { verdict },
    acceptEarly: s.acceptEarly,
  });
  const own = signal(2, OWN_RECEIPT, s.payloadAllowed ? "known" : 7);
  if (s.head === "unreadable") {
    store.pendingRecords.set(
      pendingRecordKey(own),
      new TextEncoder().encode("{"),
    );
  } else if (s.head !== "none") {
    await store.createPendingRecord(own);
  }
  if (s.head === "lapse") {
    await store.createPendingRecord({
      kind: "lapse",
      workflowId: ref.workflowId,
      key: "k",
      slot: 2,
      number: 2,
      recordedAt: at(received),
    });
  }
  if (s.below === "pending") {
    await store.createPendingRecord(signal(1, BELOW_RECEIPT, "known"));
  }
  if (s.earlier !== "none") {
    await store.settle(
      {
        kind: s.earlier,
        waitId: WAIT_ID,
        workflowId: ref.workflowId,
        runId: ref.runId,
        deadline: ref.deadline,
        settledAt: ref.deadline,
      } as WaitOutcome,
    );
  }
  const receipt = s.head === "pending" && inWindow && s.payloadAllowed
    ? OWN_RECEIPT
    : s.overRelease && s.below === "pending" && inWindow
    ? BELOW_RECEIPT
    : undefined;
  return { store, receipt };
}

/** Everything a store holds, for telling whether a call wrote to it. */
function contentsOf(store: InMemorySignalWaitStore) {
  return [
    store.registrations,
    store.outcomes,
    store.keyRecords,
    store.pendingRecords,
  ].map((records) => [...records.entries()]);
}

Deno.test("applicablePendingOutcome: finds the signal the slots give the wait and writes nothing, and takePendingSignal stores exactly that unless an outcome came first (property)", async () => {
  await fc.assert(
    fc.asyncProperty(slotsArb, async (s) => {
      const { ref } = waitingAt(s);
      const { store, receipt } = await storeOf(s, ref);
      const before = contentsOf(store);

      const peeked = await applicablePendingOutcome(store, ref);
      assertEquals(peeked?.receipt.id, receipt);
      // Asking again answers the same, and the store is as it was.
      assertEquals(await applicablePendingOutcome(store, ref), peeked);
      assertEquals(contentsOf(store), before);

      const taken = await takePendingSignal(store, ref);
      if (!peeked) {
        // Nothing applies: nothing is settled, whatever was there before.
        assertEquals(taken, { kind: "absent" });
        assertEquals(contentsOf(store), before);
      } else if (s.earlier === "none") {
        assertEquals(taken, { kind: "found", record: peeked });
        assertEquals(await store.findOutcome(WAIT_ID), taken);
      } else {
        // An outcome is written once: what settled the wait first stands.
        assertEquals(
          taken.kind === "found" ? taken.record.kind : taken.kind,
          s.earlier,
        );
      }
    }),
  );
});

Deno.test("findUnsettledWait: up to the deadline, reports a wait as waiting exactly when a resume would find it without an outcome, and writes nothing (property)", async () => {
  await fc.assert(
    fc.asyncProperty(slotsArb, async (s) => {
      const { run, ref } = waitingAt(s);
      const now = new Date(
        BASE + s.claimedAt + Math.floor(s.timeout * s.lookPermille),
      );
      const checked = await storeOf(s, ref);
      const before = contentsOf(checked.store);
      const waiting =
        (await findUnsettledWait(checked.store, run, now)) !== undefined;
      assertEquals(contentsOf(checked.store), before);

      // The resume asks the same of an identical store, and may settle.
      const resumed = await storeOf(s, ref);
      const stored = await outcomeAt(resumed.store, ref, now);
      assertEquals(waiting, stored.kind === "absent");
      assertEquals(waiting, s.earlier === "none" && !checked.receipt);
    }),
  );
});

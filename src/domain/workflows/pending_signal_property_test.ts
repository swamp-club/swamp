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
  decodePendingRecord,
  earliestReceipt,
  type EarlyWaitRef,
  encodePendingRecord,
  isReceivedForWait,
  pendingAddressFromKey,
  pendingOutcome,
  type PendingRecord,
  pendingRecordKey,
  type PendingSignal,
  takePendingSignal,
} from "./pending_signal.ts";
import { isWaitKey, WAIT_KEY_PATTERN } from "./signal_wait.ts";
import { outcomeAt } from "./signal_wait_cleanup.ts";
import type { WaitOutcome } from "./signal_wait_records.ts";
import { InMemorySignalWaitStore } from "./signal_wait_store_test_helpers.ts";

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

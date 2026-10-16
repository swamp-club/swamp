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
import fc from "fast-check";
import {
  decideEarlySignal,
  listHeldPendingSignals,
  liveSlotsOf,
} from "./early_signal.ts";
import {
  type HighestPendingRecord,
  pendingRecordKey,
  type PendingSignal,
} from "./pending_signal.ts";
import { sweepPendingSignals } from "./signal_wait_cleanup.ts";
import { InMemorySignalWaitStore } from "./signal_wait_store_test_helpers.ts";

// The listing of held pending signals (swamp-club#3214) against the two
// decisions it must agree with: the refusal of a second early signal and
// the sweep.

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();
const WORKFLOW = "wf";
const KEY = "k";

/** What a slot's records may be: its highest record decides. */
const headArb = fc.constantFrom(
  "none",
  "pending",
  "lapse",
  "unreadable",
);

/** A key's highest record, the records of each slot up to the next claim's, and a time to look. */
const keyArb = fc.record({
  highest: fc.constantFrom("none", "claim", "release"),
  generation: fc.integer({ min: 1, max: 3 }),
  // Slots 1 to 4, which covers every live slot and some the key has passed.
  heads: fc.array(headArb, { minLength: 4, maxLength: 4 }),
  receivedOffsets: fc.array(fc.integer({ min: 0, max: 600_000 }), {
    minLength: 4,
    maxLength: 4,
  }),
  acceptEarly: fc.integer({ min: 1, max: 600 }),
  lookOffset: fc.integer({ min: 0, max: 1_500_000 }),
  // Whether every live head can be read, so the refusal is decided at all.
  readableOnly: fc.boolean(),
});
type KeyState = typeof keyArb extends fc.Arbitrary<infer T> ? T : never;

async function storeOf(s: KeyState): Promise<InMemorySignalWaitStore> {
  const store = new InMemorySignalWaitStore();
  if (s.highest !== "none") {
    await store.createKeyRecord(
      s.highest === "claim"
        ? {
          kind: "claim",
          workflowId: WORKFLOW,
          key: KEY,
          generation: s.generation,
          recordedAt: at(0),
          waitId: "11111111-1111-4111-8111-111111111111",
          runId: "22222222-2222-4222-8222-222222222222",
          jobName: "main",
          stepName: "identify",
          deadline: at(3_600_000),
        }
        : {
          kind: "release",
          workflowId: WORKFLOW,
          key: KEY,
          generation: s.generation,
          recordedAt: at(0),
        },
    );
  }
  for (let index = 0; index < s.heads.length; index++) {
    const slot = index + 1;
    const head = s.heads[index];
    if (head === "none") continue;
    const pending: PendingSignal = {
      kind: "pending",
      workflowId: WORKFLOW,
      key: KEY,
      slot,
      number: 1,
      receiptId: crypto.randomUUID(),
      receivedAt: at(s.receivedOffsets[index]),
      submittedBy: "camera",
      payload: { verdict: "known" },
      acceptEarly: s.acceptEarly,
    };
    if (head === "unreadable") {
      store.pendingRecords.set(
        pendingRecordKey(pending),
        new TextEncoder().encode("{"),
      );
      continue;
    }
    await store.createPendingRecord(pending);
    if (head === "lapse") {
      await store.createPendingRecord({
        kind: "lapse",
        workflowId: WORKFLOW,
        key: KEY,
        slot,
        number: 2,
        recordedAt: at(0),
      });
    }
  }
  return store;
}

/** The heads of the live slots, as holdEarlySignal reads them. */
async function liveHeads(
  store: InMemorySignalWaitStore,
): Promise<HighestPendingRecord[]> {
  const highest = await store.highestKeyRecord(WORKFLOW, KEY);
  assert(highest.kind !== "unreadable");
  const heads: HighestPendingRecord[] = [];
  for (const slot of liveSlotsOf(highest).live) {
    heads.push(
      await store.highestPendingRecord({
        workflowId: WORKFLOW,
        key: KEY,
        slot,
      }),
    );
  }
  return heads;
}

Deno.test("listHeldPendingSignals: lists the signal decideEarlySignal refuses a second one for, and nothing when it would store; with an unreadable head only one way holds (property)", async () => {
  await fc.assert(
    fc.asyncProperty(keyArb, async (state) => {
      const s = state.readableOnly
        ? {
          ...state,
          heads: state.heads.map((head) =>
            head === "unreadable" ? "none" : head
          ),
        }
        : state;
      const store = await storeOf(s);
      const now = new Date(BASE + s.lookOffset);
      const listed = await listHeldPendingSignals(store, now);
      const heads = await liveHeads(store);
      const decision = decideEarlySignal(heads, now);
      assert(listed.length <= 1, "one signal per key at most");
      // Whatever is listed is the head of a live slot.
      const liveReceipts = heads.flatMap((head) =>
        head.kind === "found" && head.record.kind === "pending"
          ? [head.record.receiptId]
          : []
      );
      for (const each of listed) {
        assert(liveReceipts.includes(each.receiptId));
      }

      if (decision.kind === "already_pending") {
        assertEquals(listed.map((each) => each.receiptId), [
          decision.record.receiptId,
        ]);
      } else if (decision.kind === "store") {
        assertEquals(listed, []);
      } else {
        // A live head cannot be read, so the refusal is undecided. The
        // listing still shows a held signal it can read, if there is one.
        assert(!s.readableOnly);
      }
    }),
  );
});

Deno.test("listHeldPendingSignals: a listed signal is never one the sweep removes or lapses at the same time (property)", async () => {
  await fc.assert(
    fc.asyncProperty(keyArb, async (s) => {
      const store = await storeOf(s);
      const now = new Date(BASE + s.lookOffset);
      const listed = await listHeldPendingSignals(store, now);
      // Where each listed signal lives, read before the sweep.
      const addresses = [];
      for (const each of listed) {
        for (let slot = 1; slot <= s.heads.length; slot++) {
          const head = await store.highestPendingRecord({
            workflowId: WORKFLOW,
            key: KEY,
            slot,
          });
          if (
            head.kind === "found" && head.record.kind === "pending" &&
            head.record.receiptId === each.receiptId
          ) addresses.push(head.record);
        }
      }
      assertEquals(addresses.length, listed.length);

      await sweepPendingSignals(store, now);
      for (const record of addresses) {
        assertEquals(await store.highestPendingRecord(record), {
          kind: "found",
          record,
        });
      }
      assertEquals(await listHeldPendingSignals(store, now), listed);
    }),
  );
});

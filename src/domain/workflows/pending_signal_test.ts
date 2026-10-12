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

import { assertEquals, assertThrows } from "@std/assert";
import {
  decodePendingRecord,
  earliestReceipt,
  type EarlyWaitRef,
  earlyWaitRef,
  encodePendingRecord,
  heldUntil,
  isPendingHeld,
  PENDING_SIGNAL_MAX_BYTES,
  pendingAddressFromKey,
  pendingOutcome,
  pendingRecordKey,
  type PendingSignal,
  pendingSlotPrefix,
  pendingWorkflowPrefix,
  takePendingSignal,
} from "./pending_signal.ts";
import type { InputsSchema } from "../definitions/definition.ts";
import { earlySlots } from "./signal_wait.ts";
import { InMemorySignalWaitStore } from "./signal_wait_store_test_helpers.ts";

const WORKFLOW = "wf-kitchen";
const KEY = "kitchen-verdict";
const CLAIMED = new Date("2026-01-01T00:00:10.000Z");
const DEADLINE = "2026-01-01T00:00:40.000Z";
const WAIT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const SCHEMA: InputsSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["known", "intruder"] } },
};

function pending(overrides: Partial<PendingSignal> = {}): PendingSignal {
  return {
    kind: "pending",
    workflowId: WORKFLOW,
    key: KEY,
    slot: 1,
    number: 1,
    receiptId: "33333333-3333-4333-8333-333333333333",
    receivedAt: "2026-01-01T00:00:05.000Z",
    submittedBy: "camera",
    payload: { verdict: "known" },
    acceptEarly: 10,
    ...overrides,
  };
}

function ref(overrides: Partial<EarlyWaitRef> = {}): EarlyWaitRef {
  return {
    waitId: WAIT_ID,
    workflowId: WORKFLOW,
    runId: RUN_ID,
    deadline: DEADLINE,
    key: KEY,
    early: {
      generation: 1,
      overRelease: false,
      from: earliestReceipt(CLAIMED, 10),
    },
    schema: SCHEMA,
    ...overrides,
  };
}

Deno.test("pendingRecordKey: a record lives under its workflow, key, slot and number", () => {
  assertEquals(
    pendingRecordKey(pending({ slot: 3, number: 2 })),
    "wait-pending/wf-kitchen/kitchen-verdict/3/2",
  );
  assertEquals(
    pendingSlotPrefix({ workflowId: WORKFLOW, key: KEY, slot: 3 }),
    "wait-pending/wf-kitchen/kitchen-verdict/3/",
  );
  assertEquals(pendingWorkflowPrefix(WORKFLOW), "wait-pending/wf-kitchen/");
  assertEquals(
    pendingAddressFromKey("wait-pending/wf-kitchen/kitchen-verdict/3/2"),
    { workflowId: WORKFLOW, key: KEY, slot: 3, number: 2 },
  );
});

Deno.test("pendingRecordKey: an address that could name another path is refused", () => {
  assertThrows(() => pendingRecordKey(pending({ workflowId: "a/b" })));
  assertThrows(() => pendingRecordKey(pending({ workflowId: ".." })));
  assertThrows(() => pendingRecordKey(pending({ key: "../x" })));
  assertThrows(() => pendingRecordKey(pending({ slot: 0 })));
  assertThrows(() => pendingRecordKey(pending({ number: 1.5 })));
  for (
    const storeKey of [
      "wait-keys/wf/k/1/1",
      "wait-pending/wf/k/1",
      "wait-pending/wf/k/1/1/1",
      "wait-pending/wf/K/1/1",
      "wait-pending/wf/k/0/1",
      "wait-pending/wf/k/1/x",
      "wait-pending/../k/1/1",
    ]
  ) {
    assertEquals(pendingAddressFromKey(storeKey), undefined, storeKey);
  }
});

Deno.test("decodePendingRecord: a record is read back only under its own address", () => {
  const record = pending();
  const bytes = encodePendingRecord(record);
  assertEquals(decodePendingRecord(bytes, record), { kind: "found", record });
  assertEquals(decodePendingRecord(null, record), { kind: "absent" });
  for (
    const elsewhere of [
      { workflowId: "wf-other" },
      { key: "other" },
      { slot: 2 },
      { number: 2 },
    ]
  ) {
    assertEquals(
      decodePendingRecord(bytes, { ...record, ...elsewhere }),
      { kind: "unreadable" },
    );
  }
});

Deno.test("decodePendingRecord: a damaged or oversized record is unreadable, never absent", () => {
  const record = pending();
  const text = (value: string) => new TextEncoder().encode(value);
  assertEquals(decodePendingRecord(text("{"), record), { kind: "unreadable" });
  assertEquals(
    decodePendingRecord(
      text(JSON.stringify({ ...record, payload: 7 })),
      record,
    ),
    { kind: "unreadable" },
  );
  assertEquals(
    decodePendingRecord(
      text(JSON.stringify({ ...record, acceptEarly: 3601 })),
      record,
    ),
    { kind: "unreadable" },
  );
  assertEquals(
    decodePendingRecord(new Uint8Array(PENDING_SIGNAL_MAX_BYTES + 1), record),
    { kind: "unreadable" },
  );
  // Parsing drops `__proto__`; a payload that does not survive is not taken.
  const poisoned = JSON.stringify(record).replace(
    '"payload":{',
    '"payload":{"__proto__":{"x":1},',
  );
  assertEquals(decodePendingRecord(text(poisoned), record), {
    kind: "unreadable",
  });
});

Deno.test("decodePendingRecord: a lapse holds no payload", () => {
  const lapse = {
    kind: "lapse" as const,
    workflowId: WORKFLOW,
    key: KEY,
    slot: 1,
    number: 2,
    recordedAt: "2026-01-02T00:00:00.000Z",
  };
  assertEquals(decodePendingRecord(encodePendingRecord(lapse), lapse), {
    kind: "found",
    record: lapse,
  });
});

Deno.test("heldUntil: a pending signal is held for its own age limit", () => {
  const record = pending();
  assertEquals(heldUntil(record).toISOString(), "2026-01-01T00:00:15.000Z");
  assertEquals(
    isPendingHeld(record, new Date("2026-01-01T00:00:15.000Z")),
    true,
  );
  assertEquals(
    isPendingHeld(record, new Date("2026-01-01T00:00:15.001Z")),
    false,
  );
});

Deno.test("earlyWaitRef: only a wait with a key, early facts and a schema reads a slot", () => {
  const full = ref();
  assertEquals(earlyWaitRef(full), full);
  const { early: _early, ...plain } = full;
  assertEquals(earlyWaitRef(plain), undefined);
  const { schema: _schema, ...noSchema } = full;
  assertEquals(earlyWaitRef(noSchema), undefined);
});

Deno.test("earlySlots: a claim reads its own slot, and the one below when it was created over a release", () => {
  assertEquals(
    earlySlots({ generation: 3, overRelease: false, from: DEADLINE }),
    [3],
  );
  assertEquals(
    earlySlots({ generation: 3, overRelease: true, from: DEADLINE }),
    [3, 2],
  );
  assertEquals(
    earlySlots({ generation: 1, overRelease: true, from: DEADLINE }),
    [1],
  );
});

Deno.test("pendingOutcome: a signal received within the limit becomes the wait's accepted outcome, with the sender's receipt", () => {
  assertEquals(pendingOutcome(pending(), ref()), {
    kind: "accepted",
    waitId: WAIT_ID,
    workflowId: WORKFLOW,
    runId: RUN_ID,
    deadline: DEADLINE,
    settledAt: "2026-01-01T00:00:05.000Z",
    receipt: {
      id: "33333333-3333-4333-8333-333333333333",
      waitId: WAIT_ID,
      receivedAt: "2026-01-01T00:00:05.000Z",
      submittedBy: "camera",
    },
    payload: { verdict: "known" },
  });
});

Deno.test("pendingOutcome: the window runs from the claim minus the age limit to the deadline, both included", () => {
  const at = (receivedAt: string) =>
    pendingOutcome(pending({ receivedAt }), ref()) !== undefined;
  assertEquals(at("2026-01-01T00:00:00.000Z"), true);
  assertEquals(at("2025-12-31T23:59:59.999Z"), false);
  // Received after the claim: the signaller read the key before the step
  // claimed it.
  assertEquals(at("2026-01-01T00:00:20.000Z"), true);
  assertEquals(at(DEADLINE), true);
  assertEquals(at("2026-01-01T00:00:40.001Z"), false);
});

Deno.test("pendingOutcome: a payload the captured schema refuses is not taken", () => {
  assertEquals(
    pendingOutcome(pending({ payload: { verdict: "maybe" } }), ref()),
    undefined,
  );
});

Deno.test("pendingOutcome: a record for another workflow, key or slot is never taken", () => {
  assertEquals(
    pendingOutcome(pending({ workflowId: "wf-other" }), ref()),
    undefined,
  );
  assertEquals(pendingOutcome(pending({ key: "other" }), ref()), undefined);
  assertEquals(pendingOutcome(pending({ slot: 2 }), ref()), undefined);
});

Deno.test("takePendingSignal: settles the wait with the highest pending signal of its slot", async () => {
  const store = new InMemorySignalWaitStore();
  await store.createPendingRecord(pending());
  const stored = await takePendingSignal(store, ref());
  assertEquals(stored.kind === "found" && stored.record.kind, "accepted");
  assertEquals(await store.findOutcome(WAIT_ID), stored);
});

Deno.test("takePendingSignal: nothing applies, nothing is settled", async () => {
  const store = new InMemorySignalWaitStore();
  assertEquals(await takePendingSignal(store, ref()), { kind: "absent" });
  // Too old for the wait.
  await store.createPendingRecord(
    pending({ receivedAt: "2025-12-31T23:00:00.000Z" }),
  );
  assertEquals(await takePendingSignal(store, ref()), { kind: "absent" });
  assertEquals(store.outcomes.size, 0);
});

Deno.test("takePendingSignal: a lapse or an unreadable record at the head of the slot gives nothing", async () => {
  const lapsed = new InMemorySignalWaitStore();
  await lapsed.createPendingRecord(pending());
  await lapsed.createPendingRecord({
    kind: "lapse",
    workflowId: WORKFLOW,
    key: KEY,
    slot: 1,
    number: 2,
    recordedAt: "2026-01-02T00:00:00.000Z",
  });
  assertEquals(await takePendingSignal(lapsed, ref()), { kind: "absent" });

  const damaged = new InMemorySignalWaitStore();
  damaged.pendingRecords.set(
    pendingRecordKey(pending()),
    new TextEncoder().encode("{"),
  );
  assertEquals(await takePendingSignal(damaged, ref()), { kind: "absent" });
});

Deno.test("takePendingSignal: a claim created over a release also reads the slot below", async () => {
  const store = new InMemorySignalWaitStore();
  await store.createPendingRecord(pending({ slot: 2 }));
  const over = ref({
    early: {
      generation: 3,
      overRelease: true,
      from: earliestReceipt(CLAIMED, 10),
    },
  });
  const stored = await takePendingSignal(store, over);
  assertEquals(stored.kind === "found" && stored.record.kind, "accepted");
  // A claim that was not reads its own slot alone.
  const other = new InMemorySignalWaitStore();
  await other.createPendingRecord(pending({ slot: 2 }));
  assertEquals(
    await takePendingSignal(other, {
      ...over,
      early: { ...over.early, overRelease: false },
    }),
    { kind: "absent" },
  );
});

Deno.test("takePendingSignal: a wait already settled keeps its outcome", async () => {
  const store = new InMemorySignalWaitStore();
  await store.settle({
    kind: "timed_out",
    waitId: WAIT_ID,
    workflowId: WORKFLOW,
    runId: RUN_ID,
    deadline: DEADLINE,
    settledAt: "2026-01-01T00:00:41.000Z",
  });
  await store.createPendingRecord(pending());
  const stored = await takePendingSignal(store, ref());
  assertEquals(stored.kind === "found" && stored.record.kind, "timed_out");
});

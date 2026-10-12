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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { SignalWait } from "../../domain/workflows/signal_wait.ts";
import {
  cancelledOutcome,
  decideSignal,
  encodeWaitRecord,
  registrationOf,
  timedOutOutcome,
  WAIT_RECORD_MAX_BYTES,
  type WaitRegistration,
} from "../../domain/workflows/signal_wait_records.ts";
import { settledBy } from "../../domain/workflows/signal_wait_store.ts";
import {
  type AtomicControlPlaneStore,
  ControlPlaneSignalWaitStore,
  isAtomicControlPlaneStore,
} from "./control_plane_signal_wait_store.ts";
import { FileSystemControlPlaneStore } from "./fs_control_plane_store.ts";
import type { PendingSignal } from "../../domain/workflows/pending_signal.ts";
import {
  claimWaitKey,
  type WaitKeyClaim,
  waitKeyRecordKey,
  type WaitKeyRequest,
} from "../../domain/workflows/wait_key_claim.ts";

const OPENED = new Date("2026-01-01T00:00:00.000Z");
const SCHEMA = {
  type: "object" as const,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const } },
};

function registration(runId = crypto.randomUUID()): WaitRegistration {
  return registrationOf(
    {
      workflowId: "wf-1",
      workflowName: "release",
      runId,
      jobName: "main",
      stepName: "review",
    },
    SignalWait.open(SCHEMA, 60, OPENED),
    OPENED,
  );
}

function accepted(reg: WaitRegistration, verdict: string) {
  const decision = decideSignal(reg, { verdict }, "ada", OPENED);
  assert(decision.accepted);
  return decision.outcome;
}

/** An in-memory control-plane store that records the keys it is asked for. */
function memoryStore(): AtomicControlPlaneStore & {
  data: Map<string, Uint8Array>;
} {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    put: (key, bytes) => {
      data.set(key, bytes);
      return Promise.resolve();
    },
    putIfAbsent: (key, bytes) => {
      if (data.has(key)) return Promise.resolve(false);
      data.set(key, bytes);
      return Promise.resolve(true);
    },
    get: (key) => Promise.resolve(data.get(key) ?? null),
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve([...data.keys()].filter((k) => k.startsWith(prefix))),
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-wait-store-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("isAtomicControlPlaneStore: only a store with putIfAbsent qualifies", () => {
  const { putIfAbsent: _dropped, ...withoutCreate } = memoryStore();
  assertEquals(isAtomicControlPlaneStore(memoryStore()), true);
  assertEquals(
    isAtomicControlPlaneStore(withoutCreate as ControlPlaneStore),
    false,
  );
});

Deno.test("ControlPlaneSignalWaitStore: keeps registrations under waits/ and outcomes under wait-outcomes/", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  const reg = registration();

  await store.register(reg);
  await store.settle(accepted(reg, "ship"));

  assertEquals([...backing.data.keys()].sort(), [
    `wait-outcomes/${reg.waitId}`,
    `waits/${reg.waitId}`,
  ]);
  assertEquals(await store.findRegistration(reg.waitId), {
    kind: "found",
    record: reg,
  });
  assertEquals(await store.listRegistrations(), [reg]);
  assertEquals((await store.listOutcomes()).map((o) => o.kind), ["accepted"]);
});

Deno.test("ControlPlaneSignalWaitStore: a registration is written once and never replaced", async () => {
  const store = new ControlPlaneSignalWaitStore(memoryStore());
  const reg = registration();

  await store.register(reg);
  await store.register({
    ...reg,
    stepName: "other",
    deadline: reg.registeredAt,
  });

  assertEquals(await store.findRegistration(reg.waitId), {
    kind: "found",
    record: reg,
  });
});

Deno.test("ControlPlaneSignalWaitStore: the first outcome holds, and every later settle is handed it", async () => {
  const store = new ControlPlaneSignalWaitStore(memoryStore());
  const reg = registration();
  const first = accepted(reg, "ship");

  const won = await store.settle(first);
  assertEquals(won, { kind: "found", record: first });
  assertEquals(settledBy(won, first), true);

  const late = new Date("2026-01-01T00:02:00.000Z");
  for (
    const loser of [
      accepted(reg, "fix"),
      timedOutOutcome(reg, late),
      cancelledOutcome(reg, late),
    ]
  ) {
    const stored = await store.settle(loser);
    assertEquals(stored, { kind: "found", record: first });
    assertEquals(settledBy(stored, loser), false);
  }
  assertEquals(await store.listOutcomes(), [first]);
});

Deno.test("ControlPlaneSignalWaitStore: a create reported as lost after it landed is still told it won", async () => {
  // What a retried conditional write looks like when its first reply was
  // lost: the record is this writer's, and the create answers false.
  const backing = memoryStore();
  const lossy: AtomicControlPlaneStore = {
    ...backing,
    putIfAbsent: async (key, bytes) => {
      await backing.putIfAbsent(key, bytes);
      return false;
    },
  };
  const store = new ControlPlaneSignalWaitStore(lossy);
  const reg = registration();
  const outcome = accepted(reg, "ship");

  const stored = await store.settle(outcome);

  assertEquals(settledBy(stored, outcome), true);
});

Deno.test("ControlPlaneSignalWaitStore: a damaged record reads unreadable, is not listed, and is never replaced by a settle", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  const reg = registration();
  const garbage = new TextEncoder().encode("{");
  backing.data.set(`waits/${reg.waitId}`, garbage);
  backing.data.set(`wait-outcomes/${reg.waitId}`, garbage);
  // A key in the family that names no wait is skipped.
  backing.data.set("waits/README", garbage);

  assertEquals(await store.findRegistration(reg.waitId), {
    kind: "unreadable",
  });
  assertEquals(await store.listRegistrations(), []);
  assertEquals(await store.listOutcomes(), []);
  assertEquals(await store.settle(accepted(reg, "ship")), {
    kind: "unreadable",
  });
  assertEquals(backing.data.get(`wait-outcomes/${reg.waitId}`), garbage);
});

Deno.test("ControlPlaneSignalWaitStore: removing a record leaves the other, and a missing one is no error", async () => {
  const store = new ControlPlaneSignalWaitStore(memoryStore());
  const reg = registration();
  await store.register(reg);
  await store.settle(accepted(reg, "ship"));

  await store.removeRegistration(reg.waitId);
  await store.removeRegistration(reg.waitId);
  assertEquals((await store.findRegistration(reg.waitId)).kind, "absent");
  assertEquals((await store.findOutcome(reg.waitId)).kind, "found");

  await store.removeOutcome(reg.waitId);
  assertEquals((await store.findOutcome(reg.waitId)).kind, "absent");
});

Deno.test("ControlPlaneSignalWaitStore: two stores on one directory see each other's records at once", async () => {
  await withTempDir(async (dir) => {
    const one = new ControlPlaneSignalWaitStore(
      new FileSystemControlPlaneStore(dir),
    );
    const two = new ControlPlaneSignalWaitStore(
      new FileSystemControlPlaneStore(dir),
    );
    const reg = registration();

    await one.register(reg);
    assertEquals(await two.listRegistrations(), [reg]);

    const outcome = accepted(reg, "ship");
    assertEquals(settledBy(await two.settle(outcome), outcome), true);
    const loser = accepted(reg, "fix");
    assertEquals(settledBy(await one.settle(loser), loser), false);
    assertEquals(await one.findOutcome(reg.waitId), {
      kind: "found",
      record: outcome,
    });
    // On disk under the store's root, in the two key families.
    assertEquals(
      (await Deno.stat(join(dir, "_control", "waits", reg.waitId))).isFile,
      true,
    );
    assertEquals(
      (await Deno.stat(join(dir, "_control", "wait-outcomes", reg.waitId)))
        .isFile,
      true,
    );
  });
});

Deno.test("ControlPlaneSignalWaitStore: of many concurrent settles on a real directory exactly one wins, and all are handed the same outcome", async () => {
  await withTempDir(async (dir) => {
    const reg = registration();
    const outcomes = Array.from(
      { length: 12 },
      (_, i) => accepted(reg, `v${i}`),
    );

    const results = await Promise.all(
      outcomes.map((outcome) =>
        new ControlPlaneSignalWaitStore(new FileSystemControlPlaneStore(dir))
          .settle(outcome)
      ),
    );

    const winners = results.filter((stored, i) =>
      settledBy(stored, outcomes[i])
    );
    assertEquals(winners.length, 1);
    for (const stored of results) assertEquals(stored, winners[0]);
  });
});

Deno.test("ControlPlaneSignalWaitStore.register: enforces the encoded byte limit before writing, including multibyte text", async () => {
  for (const character of ["a", "é", "🐸"]) {
    for (const excess of [0, 1]) {
      const backing = memoryStore();
      let writes = 0;
      const store = new ControlPlaneSignalWaitStore({
        ...backing,
        putIfAbsent: async (key, bytes) => {
          writes++;
          return await backing.putIfAbsent(key, bytes);
        },
      });
      const reg = registration();
      reg.workflowName = "";
      const padding = WAIT_RECORD_MAX_BYTES - encodeWaitRecord(reg).byteLength;
      const width = new TextEncoder().encode(character).byteLength;
      reg.workflowName = character.repeat(Math.floor(padding / width)) +
        "x".repeat(padding % width + excess);
      assertEquals(
        encodeWaitRecord(reg).byteLength,
        WAIT_RECORD_MAX_BYTES + excess,
      );
      if (excess) {
        await assertRejects(
          () => store.register(reg),
          Error,
          `${
            WAIT_RECORD_MAX_BYTES + excess
          } bytes, over the ${WAIT_RECORD_MAX_BYTES} byte limit`,
        );
        assertEquals(writes, 0);
        assertEquals(backing.data.size, 0);
      } else {
        await store.register(reg);
        assertEquals(writes, 1);
        assertEquals(await store.findRegistration(reg.waitId), {
          kind: "found",
          record: reg,
        });
        const outcome = accepted(reg, "ship");
        assertEquals(await store.settle(outcome), {
          kind: "found",
          record: outcome,
        });
      }
    }
  }
});

// Key records (swamp-club#3209).

function keyRequest(overrides: Partial<WaitKeyRequest> = {}): WaitKeyRequest {
  return {
    workflowId: "wf-1",
    key: "verdict",
    waitId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    jobName: "main",
    stepName: "review",
    deadline: "2026-01-01T01:00:00.000Z",
    ...overrides,
  };
}

function keyClaim(generation: number, key = "verdict"): WaitKeyClaim {
  return {
    kind: "claim",
    ...keyRequest({ key }),
    generation,
    recordedAt: OPENED.toISOString(),
  };
}

Deno.test("ControlPlaneSignalWaitStore: a key record is created once per generation, and the create answers with what is stored", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  const first = keyClaim(1);
  const rival = keyClaim(1);

  assertEquals(await store.createKeyRecord(first), {
    kind: "found",
    record: first,
  });
  assertEquals(await store.createKeyRecord(rival), {
    kind: "found",
    record: first,
  });
  assertEquals([...backing.data.keys()], ["wait-keys/wf-1/verdict/1"]);
});

Deno.test("ControlPlaneSignalWaitStore.highestKeyRecord: reads the highest generation of one key, by number and not by name", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  assertEquals(await store.highestKeyRecord("wf-1", "verdict"), {
    kind: "none",
  });
  for (const generation of [1, 2, 9, 10]) {
    await store.createKeyRecord(keyClaim(generation));
  }
  await store.createKeyRecord(keyClaim(40, "other"));
  await store.createKeyRecord({ ...keyClaim(50), workflowId: "wf-2" });

  const highest = await store.highestKeyRecord("wf-1", "verdict");
  assert(highest.kind === "found");
  assertEquals(highest.record.generation, 10);

  // A highest record that does not parse is unreadable, never passed over.
  backing.data.set("wait-keys/wf-1/verdict/11", new TextEncoder().encode("{"));
  assertEquals(await store.highestKeyRecord("wf-1", "verdict"), {
    kind: "unreadable",
    generation: 11,
  });
  // A key of the family that names no record is not a generation.
  backing.data.set("wait-keys/wf-1/other/latest", new Uint8Array());
  const other = await store.highestKeyRecord("wf-1", "other");
  assert(other.kind === "found");
  assertEquals(other.record.generation, 40);
});

Deno.test("ControlPlaneSignalWaitStore: lists readable key records, removes one, and removes a workflow's without touching another's", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  const a = keyClaim(1);
  const b = keyClaim(2);
  const elsewhere = { ...keyClaim(1), workflowId: "wf-2" };
  for (const record of [a, b, elsewhere]) await store.createKeyRecord(record);
  backing.data.set("wait-keys/wf-1/verdict/3", new TextEncoder().encode("{"));

  assertEquals(
    (await store.listKeyRecords()).map(waitKeyRecordKey).sort(),
    [a, b, elsewhere].map(waitKeyRecordKey).sort(),
  );

  await store.removeKeyRecord(a);
  assertEquals(backing.data.has(waitKeyRecordKey(a)), false);

  await store.removeKeyRecordsOfWorkflow("wf-1");
  assertEquals([...backing.data.keys()], [waitKeyRecordKey(elsewhere)]);
  // Registrations and outcomes are another family and are left alone.
  const reg = registration();
  await store.register(reg);
  await store.removeKeyRecordsOfWorkflow("wf-1");
  assertEquals((await store.listRegistrations()).length, 1);
});

Deno.test("ControlPlaneSignalWaitStore: of many concurrent claims of a free key on a real directory exactly one is acquired", async () => {
  await withTempDir(async (dir) => {
    const stores = Array.from(
      { length: 12 },
      () =>
        new ControlPlaneSignalWaitStore(new FileSystemControlPlaneStore(dir)),
    );
    const results = await Promise.all(
      stores.map((store) => claimWaitKey(store, keyRequest(), OPENED)),
    );
    const acquired = results.filter((r) => r.kind === "acquired");
    assertEquals(acquired.length, 1);
    assertEquals(
      results.filter((r) => r.kind === "held").length,
      stores.length - 1,
    );
    assertEquals(
      (await Deno.stat(
        join(dir, "_control", "wait-keys", "wf-1", "verdict", "1"),
      ))
        .isFile,
      true,
    );
    assertEquals((await stores[0].listKeyRecords()).length, 1);
  });
});

Deno.test("ControlPlaneSignalWaitStore.highestKeyRecord: a listing that keeps naming a record that is gone ends as unreadable, after a bounded number of reads", async () => {
  const backing = memoryStore();
  let listings = 0;
  const stale: AtomicControlPlaneStore = {
    ...backing,
    list: (prefix) => {
      listings++;
      return Promise.resolve(
        prefix.startsWith("wait-keys/") ? ["wait-keys/wf-1/verdict/7"] : [],
      );
    },
  };
  const store = new ControlPlaneSignalWaitStore(stale);

  assertEquals(await store.highestKeyRecord("wf-1", "verdict"), {
    kind: "unreadable",
    generation: 7,
  });
  assertEquals(listings, 4);
});

Deno.test("ControlPlaneSignalWaitStore.highestKeyRecord: a record removed between the listing and the read is passed over for what superseded it", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  const kept = keyClaim(2);
  await store.createKeyRecord(kept);
  let first = true;
  const racing = new ControlPlaneSignalWaitStore({
    ...backing,
    list: async (prefix) => {
      const keys = await backing.list(prefix);
      if (!first) return keys;
      first = false;
      return ["wait-keys/wf-1/verdict/1", ...keys].filter((k) =>
        k !== "wait-keys/wf-1/verdict/2"
      );
    },
  });

  assertEquals(await racing.highestKeyRecord("wf-1", "verdict"), {
    kind: "found",
    record: kept,
  });
});

// Pending signals (swamp-club#3212).

function pendingSignal(
  overrides: Partial<PendingSignal> = {},
): PendingSignal {
  return {
    kind: "pending",
    workflowId: "wf-1",
    key: "verdict",
    slot: 1,
    number: 1,
    receiptId: "33333333-3333-4333-8333-333333333333",
    receivedAt: "2026-01-01T00:00:00.000Z",
    submittedBy: "camera",
    payload: { verdict: "known" },
    acceptEarly: 10,
    ...overrides,
  };
}

Deno.test("ControlPlaneSignalWaitStore: a pending signal is created once under its slot and number, and the first writer holds it", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  const first = pendingSignal();
  assertEquals(await store.createPendingRecord(first), {
    kind: "found",
    record: first,
  });
  assertEquals([...backing.data.keys()], ["wait-pending/wf-1/verdict/1/1"]);
  // A second create of the same number is answered with what is stored.
  const second = pendingSignal({
    receiptId: "44444444-4444-4444-8444-444444444444",
  });
  assertEquals(await store.createPendingRecord(second), {
    kind: "found",
    record: first,
  });
});

Deno.test("ControlPlaneSignalWaitStore.highestPendingRecord: reads the highest number of one slot, and says so when it cannot be read", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  const slot = { workflowId: "wf-1", key: "verdict", slot: 1 };
  assertEquals(await store.highestPendingRecord(slot), { kind: "none" });
  await store.createPendingRecord(pendingSignal());
  const newer = pendingSignal({ number: 2 });
  await store.createPendingRecord(newer);
  // Another slot and another key are not this slot's.
  await store.createPendingRecord(pendingSignal({ slot: 2, number: 9 }));
  await store.createPendingRecord(pendingSignal({ key: "other", number: 9 }));
  assertEquals(await store.highestPendingRecord(slot), {
    kind: "found",
    record: newer,
  });
  backing.data.set(
    "wait-pending/wf-1/verdict/1/3",
    new TextEncoder().encode("{"),
  );
  assertEquals(await store.highestPendingRecord(slot), {
    kind: "unreadable",
    number: 3,
  });
});

Deno.test("ControlPlaneSignalWaitStore: pending records are listed by address, readable or not, and removed one by one or with their workflow", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  await store.createPendingRecord(pendingSignal());
  await store.createPendingRecord(pendingSignal({ workflowId: "wf-2" }));
  backing.data.set(
    "wait-pending/wf-1/verdict/1/2",
    new TextEncoder().encode("{"),
  );
  backing.data.set("wait-pending/wf-1/not a key/1/1", new Uint8Array());
  assertEquals(
    (await store.listPendingAddresses()).map((at) =>
      `${at.workflowId}/${at.slot}/${at.number}`
    ).sort(),
    ["wf-1/1/1", "wf-1/1/2", "wf-2/1/1"],
  );
  await store.removePendingRecord({
    workflowId: "wf-1",
    key: "verdict",
    slot: 1,
    number: 2,
  });
  assertEquals((await store.listPendingAddresses()).length, 2);
  await store.removePendingRecordsOfWorkflow("wf-1");
  assertEquals(
    [...backing.data.keys()],
    ["wait-pending/wf-2/verdict/1/1"],
  );
});

Deno.test("ControlPlaneSignalWaitStore: pending signals are kept on a real filesystem store", async () => {
  await withTempDir(async (dir) => {
    const backing = new FileSystemControlPlaneStore(dir);
    assert(isAtomicControlPlaneStore(backing));
    const store = new ControlPlaneSignalWaitStore(backing);
    const record = pendingSignal();
    await store.createPendingRecord(record);
    // Read by another instance over the same directory.
    const other = new ControlPlaneSignalWaitStore(
      new FileSystemControlPlaneStore(dir) as AtomicControlPlaneStore,
    );
    assertEquals(
      await other.highestPendingRecord({
        workflowId: "wf-1",
        key: "verdict",
        slot: 1,
      }),
      { kind: "found", record },
    );
    assertEquals(await other.listPendingAddresses(), [{
      workflowId: "wf-1",
      key: "verdict",
      slot: 1,
      number: 1,
    }]);
  });
});

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
import {
  principalKeyOf,
  type QuarantineRecord,
} from "../../domain/datastore_v3/quarantine.ts";
import { ControlPlaneQuarantineStore } from "./control_plane_quarantine_store.ts";

/** A control-plane store in memory, recording the order of writes. */
function memoryControlPlane() {
  const records = new Map<string, Uint8Array>();
  const writes: string[] = [];
  return {
    records,
    writes,
    put: (key: string, data: Uint8Array) => {
      writes.push(`put ${key.split("/")[0]}`);
      records.set(key, data);
      return Promise.resolve();
    },
    get: (key: string) => Promise.resolve(records.get(key) ?? null),
    delete: (key: string) => {
      writes.push(`delete ${key.split("/")[0]}`);
      records.delete(key);
      return Promise.resolve();
    },
    list: (prefix: string) =>
      Promise.resolve(
        [...records.keys()].filter((key) => key.startsWith(prefix)).sort(),
      ),
  };
}

function record(
  overrides: Partial<QuarantineRecord> = {},
): QuarantineRecord {
  return {
    txnId: crypto.randomUUID(),
    partition: "model--aws%2Fec2--web",
    principal: "user:bob",
    reason: "Not authorized",
    depositedAt: "2026-10-30T12:00:00.000Z",
    bytes: 10,
    state: "held",
    ...overrides,
  };
}

const CONTENT = { commit: { a: 1 }, base: { seq: 0 }, chunks: [] };

Deno.test("ControlPlaneQuarantineStore.deposit: writes the content before the record, so a held record always has its content", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneQuarantineStore(shared);
  const held = record();
  await store.deposit(held, CONTENT);
  assertEquals(shared.writes, ["put quarantine-content", "put quarantine"]);
  assertEquals(await store.find(held.txnId), held);
  assertEquals(await store.content(held.txnId), CONTENT);
  assertEquals((await store.heldKeys()).length, 1);
});

Deno.test("ControlPlaneQuarantineStore.markAccepted: keeps an accepted record and drops the held one and its content", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneQuarantineStore(shared);
  const held = record();
  await store.deposit(held, CONTENT);
  const accepted: QuarantineRecord = {
    ...held,
    state: "accepted",
    acceptedBy: "user:admin",
    acceptedAt: "2026-10-30T13:00:00.000Z",
    seq: 3,
  };
  await store.markAccepted(accepted);
  assertEquals(await store.find(held.txnId), accepted);
  assertEquals(await store.content(held.txnId), undefined);
  assertEquals(await store.heldKeys(), []);
});

Deno.test("ControlPlaneQuarantineStore.find: an accepted record wins over a held one a crash left behind", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneQuarantineStore(shared);
  const held = record();
  await store.deposit(held, CONTENT);
  // A crash after the accepted record, before the held one went.
  const accepted = { ...held, state: "accepted" as const, seq: 2 };
  const key = (await store.heldKeys())[0].replace(
    "quarantine/",
    "quarantine-accepted/",
  );
  shared.records.set(
    key,
    new TextEncoder().encode(JSON.stringify({ v: 1, ...accepted })),
  );
  assertEquals((await store.find(held.txnId))?.state, "accepted");
  const { records } = await store.list(10);
  assertEquals(records.map((entry) => entry.state), ["accepted"]);
});

Deno.test("ControlPlaneQuarantineStore.list: held records oldest first, then accepted newest first, bounded", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneQuarantineStore(shared);
  const late = record({ depositedAt: "2026-10-30T12:05:00.000Z" });
  const early = record({ depositedAt: "2026-10-30T12:01:00.000Z" });
  await store.deposit(late, CONTENT);
  await store.deposit(early, CONTENT);
  for (const minute of [1, 2, 3]) {
    const done = record();
    await store.deposit(done, CONTENT);
    await store.markAccepted({
      ...done,
      state: "accepted",
      acceptedAt: `2026-10-30T13:0${minute}:00.000Z`,
    });
  }
  const { records, truncated } = await store.list(2);
  assertEquals(records.map((entry) => entry.depositedAt).slice(0, 2), [
    early.depositedAt,
    late.depositedAt,
  ]);
  assertEquals(records.slice(2).map((entry) => entry.acceptedAt), [
    "2026-10-30T13:03:00.000Z",
    "2026-10-30T13:02:00.000Z",
  ]);
  assertEquals(truncated, true);
});

Deno.test("ControlPlaneQuarantineStore: an unreadable record is skipped, never thrown", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneQuarantineStore(shared);
  const held = record();
  await store.deposit(held, CONTENT);
  const [key] = await store.heldKeys();
  shared.records.set(key, new TextEncoder().encode("not json"));
  assertEquals(await store.find(held.txnId), undefined);
  assertEquals((await store.list(10)).records, []);
});

Deno.test("ControlPlaneQuarantineStore.heldBytesOf: sums an author's held records only, so a discard frees its bytes", async () => {
  const shared = memoryControlPlane();
  const store = new ControlPlaneQuarantineStore(shared);
  const first = record({ bytes: 100 });
  const second = record({ bytes: 250 });
  const alices = record({ principal: "user:alice", bytes: 7 });
  await store.deposit(first, CONTENT);
  await store.deposit(second, CONTENT);
  await store.deposit(alices, CONTENT);
  const bob = await principalKeyOf("user:bob");
  assertEquals(await store.heldBytesOf(bob), 350);
  await store.markDiscarded({
    ...first,
    state: "discarded",
    discardedBy: "user:admin",
    discardedAt: "2026-10-30T13:00:00.000Z",
  });
  assertEquals(await store.heldBytesOf(bob), 250);
});

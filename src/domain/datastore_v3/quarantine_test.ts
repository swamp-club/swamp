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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  boundedQuarantineReason,
  carriesExactly,
  chunksOf,
  chunksToWire,
  MAX_QUARANTINED_BYTES_PER_PRINCIPAL,
  MAX_QUARANTINED_PER_PRINCIPAL,
  parseQuarantineContent,
  parseQuarantineRecord,
  parseQuarantineRecordKey,
  principalKeyOf,
  quarantineHasRoom,
  type QuarantineRecord,
  QuarantineRecordInvalidError,
  quarantineRecordKey,
  serializeQuarantineContent,
  serializeQuarantineRecord,
} from "./quarantine.ts";

const TXN = "0f8c57cf-4f22-4233-bf81-ecc6b4492fb8";

const RECORD: QuarantineRecord = {
  txnId: TXN,
  partition: "model--aws%2Fec2--web",
  principal: "user:bob",
  reason: "Not authorized to write model:web (data.save)",
  depositedAt: "2026-10-30T12:00:00.000Z",
  bytes: 120,
  state: "held",
};

Deno.test("principalKeyOf: names any principal as one hex segment", async () => {
  const key = await principalKeyOf("user:bob@example.com/x");
  assertEquals(/^[0-9a-f]{64}$/.test(key), true);
  assertEquals(await principalKeyOf("user:bob@example.com/x"), key);
});

Deno.test("quarantineRecordKey: round-trips through parseQuarantineRecordKey", async () => {
  const principalKey = await principalKeyOf("user:bob");
  for (const state of ["held", "accepted", "discarded"] as const) {
    assertEquals(
      parseQuarantineRecordKey(quarantineRecordKey(state, TXN, principalKey)),
      { state, txnId: TXN, principalKey },
    );
  }
  assertEquals(parseQuarantineRecordKey("quarantine/not-a-txn/abc"), undefined);
  assertEquals(parseQuarantineRecordKey(`leases/1/${principalKey}`), undefined);
  assertEquals(
    parseQuarantineRecordKey(`quarantine/${TXN}/${principalKey}/extra`),
    undefined,
  );
});

Deno.test("quarantineHasRoom: caps each author and everyone", async () => {
  const bob = await principalKeyOf("user:bob");
  const alice = await principalKeyOf("user:alice");
  const keysOf = (principalKey: string, count: number) =>
    Array.from(
      { length: count },
      () => quarantineRecordKey("held", crypto.randomUUID(), principalKey),
    );
  assertEquals(quarantineHasRoom([], bob), true);
  const full = keysOf(bob, MAX_QUARANTINED_PER_PRINCIPAL);
  assertEquals(quarantineHasRoom(full, bob), false);
  assertEquals(quarantineHasRoom(full, alice), true);
  // Keys that are not held records do not count, a discarded one included.
  assertEquals(
    quarantineHasRoom([...full.slice(1), "quarantine/junk"], bob),
    true,
  );
  assertEquals(
    quarantineHasRoom([
      ...full.slice(1),
      quarantineRecordKey("discarded", crypto.randomUUID(), bob),
    ], bob),
    true,
  );
});

Deno.test("parseQuarantineRecord: round-trips a record and refuses a damaged one", () => {
  assertEquals(
    parseQuarantineRecord(serializeQuarantineRecord(RECORD)),
    RECORD,
  );
  const accepted: QuarantineRecord = {
    ...RECORD,
    state: "accepted",
    acceptedBy: "user:admin",
    acceptedAt: "2026-10-30T13:00:00.000Z",
    seq: 4,
  };
  assertEquals(
    parseQuarantineRecord(serializeQuarantineRecord(accepted)),
    accepted,
  );
  const discarded: QuarantineRecord = {
    ...RECORD,
    state: "discarded",
    discardedBy: "user:admin",
    discardedAt: "2026-10-30T13:00:00.000Z",
  };
  assertEquals(
    parseQuarantineRecord(serializeQuarantineRecord(discarded)),
    discarded,
  );
  const bad = (fields: Record<string, unknown>) =>
    new TextEncoder().encode(JSON.stringify({ v: 1, ...RECORD, ...fields }));
  for (
    const fields of [
      { txnId: "nope" },
      { state: "lost" },
      { bytes: -1 },
      { principal: "" },
      { seq: 0 },
      { discardedBy: "" },
      { v: 2 },
    ]
  ) {
    assertThrows(
      () => parseQuarantineRecord(bad(fields)),
      QuarantineRecordInvalidError,
    );
  }
  assertThrows(
    () => parseQuarantineRecord(new TextEncoder().encode("{")),
    QuarantineRecordInvalidError,
  );
});

Deno.test("parseQuarantineRecord: keeps the author's groups and collectives an accept judges content with, and refuses malformed ones", () => {
  const withMemberships = {
    ...RECORD,
    groups: ["platform"],
    collectives: ["acme"],
  };
  assertEquals(
    parseQuarantineRecord(serializeQuarantineRecord(withMemberships)),
    withMemberships,
  );
  const bad = (fields: Record<string, unknown>) =>
    new TextEncoder().encode(JSON.stringify({ v: 1, ...RECORD, ...fields }));
  for (
    const fields of [
      { groups: "platform" },
      { groups: [""] },
      { collectives: [1] },
      { groups: Array.from({ length: 257 }, (_, i) => `g${i}`) },
    ]
  ) {
    assertThrows(
      () => parseQuarantineRecord(bad(fields)),
      QuarantineRecordInvalidError,
    );
  }
});

Deno.test("parseQuarantineContent: round-trips content and refuses bytes that do not hash as named", async () => {
  const bytes = new TextEncoder().encode("chunk bytes");
  const [wire] = chunksToWire([{ sha256: "0".repeat(64), bytes }]);
  await assertRejects(
    () => chunksOf([wire]),
    QuarantineRecordInvalidError,
    "does not hold its own bytes",
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const content = {
    commit: { any: "commit" },
    base: { seq: 3, txnId: TXN },
    chunks: [{ sha256, bytes }],
  };
  assertEquals(
    await parseQuarantineContent(serializeQuarantineContent(content)),
    content,
  );
  await assertRejects(
    () =>
      parseQuarantineContent(
        serializeQuarantineContent({ ...content, base: { seq: -1 } }),
      ),
    QuarantineRecordInvalidError,
  );
});

Deno.test("chunksOf: refuses a chunk named twice", async () => {
  const bytes = new TextEncoder().encode("chunk bytes");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const [wire] = chunksToWire([{ sha256, bytes }]);
  await assertRejects(
    () => chunksOf([wire, wire]),
    QuarantineRecordInvalidError,
    "more than once",
  );
});

Deno.test("carriesExactly: holds only for the named chunks, each once", () => {
  const chunk = (sha256: string) => ({ sha256, bytes: new Uint8Array() });
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  assertEquals(carriesExactly([chunk(a), chunk(b)], new Set([a, b])), true);
  assertEquals(carriesExactly([chunk(a), chunk(a)], new Set([a, b])), false);
  assertEquals(carriesExactly([chunk(a)], new Set([a, b])), false);
  assertEquals(carriesExactly([chunk(a), chunk(b)], new Set([a])), false);
  assertEquals(carriesExactly([], new Set()), true);
});

Deno.test("boundedQuarantineReason: keeps a short reason and bounds a long one", () => {
  assertEquals(boundedQuarantineReason("short"), "short");
  assertEquals(boundedQuarantineReason("x".repeat(5000)).length, 2048);
});

Deno.test("quarantineHasRoom: caps the bytes each author holds", async () => {
  const bob = await principalKeyOf("user:bob");
  const deposit = 32 * 1024 * 1024;
  assertEquals(
    quarantineHasRoom([], bob, { held: 0, deposit }),
    true,
  );
  assertEquals(
    quarantineHasRoom([], bob, {
      held: MAX_QUARANTINED_BYTES_PER_PRINCIPAL - deposit,
      deposit,
    }),
    true,
  );
  assertEquals(
    quarantineHasRoom([], bob, {
      held: MAX_QUARANTINED_BYTES_PER_PRINCIPAL - deposit + 1,
      deposit,
    }),
    false,
  );
});

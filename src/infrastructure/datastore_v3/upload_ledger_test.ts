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
import { DEFAULT_CHUNK_GRACE_MS } from "../../domain/datastore_v3/chunk_collector.ts";
import {
  DEFAULT_MAX_UNREFERENCED_UPLOAD_BYTES,
  type UploadAdmission,
  UploadLedger,
  type UploadReservation,
} from "./upload_ledger.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const T0 = 1_000_000;

function reserved(admission: UploadAdmission): UploadReservation {
  if (!admission.allowed) {
    throw new Error(`refused: ${admission.reason}`);
  }
  return admission.reservation;
}

/** Reserves and records one upload, as serve does once it is stored. */
function put(
  ledger: UploadLedger,
  principalId: string,
  namespace: string,
  sha256: string,
  size: number,
  now: number,
): void {
  ledger.record(
    reserved(ledger.reserve(principalId, size, now)),
    namespace,
    sha256,
    now,
  );
}

Deno.test("UploadLedger: holds a recorded chunk only for its principal and namespace", () => {
  const ledger = new UploadLedger();
  put(ledger, "alice", "ns1", A, 10, T0);
  assertEquals(ledger.holds("alice", "ns1", A, T0), true);
  assertEquals(ledger.holds("bob", "ns1", A, T0), false);
  assertEquals(ledger.holds("alice", "ns2", A, T0), false);
  assertEquals(ledger.holds("alice", "ns1", B, T0), false);
});

Deno.test("UploadLedger: defaults to the chunk sweep's grace window and a 2 GiB quota", () => {
  const ledger = new UploadLedger();
  assertEquals(ledger.graceMs, DEFAULT_CHUNK_GRACE_MS);
  assertEquals(
    ledger.maxUnreferencedBytesPerPrincipal,
    2 * 1024 * 1024 * 1024,
  );
  assertEquals(DEFAULT_MAX_UNREFERENCED_UPLOAD_BYTES, 2 ** 31);
});

Deno.test("UploadLedger: an upload stops holding when its grace window ends", () => {
  const ledger = new UploadLedger({ graceMs: 1000 });
  put(ledger, "alice", "ns", A, 10, T0);
  assertEquals(ledger.holds("alice", "ns", A, T0 + 999), true);
  assertEquals(ledger.holds("alice", "ns", A, T0 + 1000), false);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 1000), 0);
  assertEquals(ledger.size, 0);
});

Deno.test("UploadLedger: recording again restarts the window without double counting", () => {
  const ledger = new UploadLedger({ graceMs: 1000 });
  put(ledger, "alice", "ns", A, 10, T0);
  put(ledger, "alice", "ns", A, 10, T0 + 800);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 800), 10);
  assertEquals(ledger.holds("alice", "ns", A, T0 + 1500), true);
  assertEquals(ledger.size, 1);
});

Deno.test("UploadLedger: unreferencedBytes sums a principal's live, unreleased uploads", () => {
  const ledger = new UploadLedger({ graceMs: 1000 });
  put(ledger, "alice", "ns", A, 10, T0);
  put(ledger, "alice", "ns", B, 20, T0 + 500);
  put(ledger, "bob", "ns", C, 40, T0);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 500), 30);
  assertEquals(ledger.unreferencedBytes("bob", T0 + 500), 40);
  assertEquals(ledger.unreferencedBytes("carol", T0 + 500), 0);
  // A's window ends; B's has not.
  assertEquals(ledger.unreferencedBytes("alice", T0 + 1000), 20);
});

Deno.test("UploadLedger: release stops the bytes counting but keeps the proof", () => {
  const ledger = new UploadLedger({ graceMs: 1000 });
  put(ledger, "alice", "ns", A, 10, T0);
  put(ledger, "bob", "ns", A, 10, T0);
  put(ledger, "alice", "ns", B, 20, T0);
  put(ledger, "alice", "other", A, 5, T0);
  ledger.release("ns", [A, C]);
  assertEquals(ledger.unreferencedBytes("alice", T0), 25);
  assertEquals(ledger.unreferencedBytes("bob", T0), 0);
  assertEquals(ledger.holds("alice", "ns", A, T0), true);
  assertEquals(ledger.holds("bob", "ns", A, T0), true);
  // Releasing twice changes nothing.
  ledger.release("ns", [A]);
  assertEquals(ledger.unreferencedBytes("alice", T0), 25);
  // A released entry expiring does not take the count below zero.
  assertEquals(ledger.unreferencedBytes("bob", T0 + 1000), 0);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 1000), 0);
});

Deno.test("UploadLedger: a released chunk recorded again counts again", () => {
  const ledger = new UploadLedger();
  put(ledger, "alice", "ns", A, 10, T0);
  ledger.release("ns", [A]);
  put(ledger, "alice", "ns", A, 10, T0 + 1);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 1), 10);
});

/** Whether a reservation is granted; a granted one is cancelled at once. */
function allowed(admission: UploadAdmission): boolean {
  if (admission.allowed) admission.reservation.cancel();
  return admission.allowed;
}

Deno.test("UploadLedger: reserve refuses past the per-principal byte quota", () => {
  const ledger = new UploadLedger({
    graceMs: 1000,
    maxUnreferencedBytesPerPrincipal: 100,
  });
  assertEquals(allowed(ledger.reserve("alice", 100, T0)), true);
  assertEquals(allowed(ledger.reserve("alice", 101, T0)), false);
  put(ledger, "alice", "ns", A, 60, T0);
  assertEquals(allowed(ledger.reserve("alice", 40, T0)), true);
  assertEquals(ledger.reserve("alice", 41, T0), {
    allowed: false,
    reason: "bytes",
    unreferencedBytes: 60,
    limitBytes: 100,
  });
  // Other principals have their own quota.
  assertEquals(allowed(ledger.reserve("bob", 100, T0)), true);
  // Releasing frees quota.
  ledger.release("ns", [A]);
  assertEquals(allowed(ledger.reserve("alice", 100, T0)), true);
  // So does the window ending.
  put(ledger, "alice", "ns", B, 100, T0);
  assertEquals(allowed(ledger.reserve("alice", 1, T0 + 999)), false);
  assertEquals(allowed(ledger.reserve("alice", 1, T0 + 1000)), true);
});

Deno.test("UploadLedger: reserve refuses past the per-principal entry cap", () => {
  const ledger = new UploadLedger({ maxEntriesPerPrincipal: 2 });
  put(ledger, "alice", "ns", A, 0, T0);
  assertEquals(allowed(ledger.reserve("alice", 0, T0)), true);
  put(ledger, "alice", "ns", B, 0, T0);
  const refused = ledger.reserve("alice", 0, T0);
  assertEquals(refused.allowed, false);
  if (!refused.allowed) assertEquals(refused.reason, "entries");
  assertEquals(allowed(ledger.reserve("bob", 0, T0)), true);
});

Deno.test("UploadLedger: released entries do not count toward the per-principal entry cap", () => {
  // swamp-club#3938: a busy client whose uploads every commit references
  // must not be locked out until its entries expire.
  const ledger = new UploadLedger({ maxEntriesPerPrincipal: 2 });
  put(ledger, "alice", "ns", A, 1, T0);
  put(ledger, "alice", "ns", B, 1, T0);
  assertEquals(allowed(ledger.reserve("alice", 1, T0)), false);
  ledger.release("ns", [A, B]);
  assertEquals(allowed(ledger.reserve("alice", 1, T0)), true);
  // The released uploads still hold, for a retried commit.
  assertEquals(ledger.holds("alice", "ns", A, T0), true);
  // An unreleased entry still counts.
  put(ledger, "alice", "ns", C, 1, T0);
  put(ledger, "alice", "ns", "d".repeat(64), 1, T0);
  assertEquals(allowed(ledger.reserve("alice", 1, T0)), false);
});

Deno.test("UploadLedger: outstanding reservations count toward the byte quota and entry cap", () => {
  // swamp-club#3938: requests in flight together are each admitted
  // against what the others reserved, not against what was recorded.
  const ledger = new UploadLedger({
    maxUnreferencedBytesPerPrincipal: 100,
    maxEntriesPerPrincipal: 3,
  });
  const first = reserved(ledger.reserve("alice", 60, T0));
  assertEquals(ledger.reserve("alice", 41, T0).allowed, false);
  const second = reserved(ledger.reserve("alice", 40, T0));
  assertEquals(ledger.reserved, 2);
  // Cancelling gives the room back, once.
  second.cancel();
  second.cancel();
  assertEquals(ledger.reserved, 1);
  reserved(ledger.reserve("alice", 0, T0));
  reserved(ledger.reserve("alice", 0, T0));
  const refused = ledger.reserve("alice", 0, T0);
  assertEquals(refused.allowed, false);
  if (!refused.allowed) assertEquals(refused.reason, "entries");
  // Recording spends the reservation: the bytes are now the entry's.
  ledger.record(first, "ns", A, T0);
  first.cancel();
  assertEquals(ledger.unreferencedBytes("alice", T0), 60);
  assertEquals(ledger.reserved, 2);
});

Deno.test("UploadLedger: record needs a live reservation from the same ledger", () => {
  const ledger = new UploadLedger();
  const other = new UploadLedger();
  const foreign = reserved(other.reserve("alice", 1, T0));
  assertThrows(() => ledger.record(foreign, "ns", A, T0));
  const spent = reserved(ledger.reserve("alice", 1, T0));
  ledger.record(spent, "ns", A, T0);
  assertThrows(() => ledger.record(spent, "ns", B, T0));
  const cancelled = reserved(ledger.reserve("alice", 1, T0));
  cancelled.cancel();
  assertThrows(() => ledger.record(cancelled, "ns", B, T0));
  assertEquals(ledger.size, 1);
});

Deno.test("UploadLedger: at the global cap, the oldest released entry makes room first", () => {
  const ledger = new UploadLedger({ maxEntries: 3 });
  put(ledger, "alice", "ns", A, 1, T0);
  put(ledger, "bob", "ns", B, 2, T0 + 1);
  put(ledger, "alice", "ns", C, 4, T0 + 2);
  // C's commit landed: C is released and goes before the older A and B.
  ledger.release("ns", [C]);
  put(ledger, "carol", "ns", A, 8, T0 + 3);
  assertEquals(ledger.size, 3);
  assertEquals(ledger.holds("alice", "ns", C, T0 + 3), false);
  assertEquals(ledger.holds("alice", "ns", A, T0 + 3), true);
  assertEquals(ledger.holds("bob", "ns", B, T0 + 3), true);
  assertEquals(ledger.holds("carol", "ns", A, T0 + 3), true);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 3), 1);
});

Deno.test("UploadLedger: at the global cap, a light principal's uploads are never evicted for a heavier one", () => {
  // swamp-club#3938: eviction took the oldest entries whoever owned them.
  const ledger = new UploadLedger({ maxEntries: 4 });
  put(ledger, "bob", "ns", A, 1, T0);
  for (let i = 0; i < 3; i++) {
    put(ledger, "flood", "ns", i.toString(16).padStart(64, "0"), 1, T0 + 1);
  }
  // The ledger is full and the flooder holds the most: it is refused,
  // rather than pushing out bob's older upload.
  const refused = ledger.reserve("flood", 1, T0 + 2);
  assertEquals(refused.allowed, false);
  if (!refused.allowed) assertEquals(refused.reason, "full");
  assertEquals(ledger.holds("bob", "ns", A, T0 + 2), true);
  // A lighter principal's upload makes room from the flooder's oldest.
  put(ledger, "carol", "ns", B, 1, T0 + 2);
  assertEquals(ledger.holds("bob", "ns", A, T0 + 2), true);
  assertEquals(ledger.holds("carol", "ns", B, T0 + 2), true);
  assertEquals(
    ledger.holds("flood", "ns", "0".padStart(64, "0"), T0 + 2),
    false,
  );
  assertEquals(ledger.size, 4);
});

Deno.test("UploadLedger: at the global cap, a caller tied for the most uploads is refused", () => {
  const ledger = new UploadLedger({ maxEntries: 2 });
  put(ledger, "alice", "ns", A, 1, T0);
  put(ledger, "bob", "ns", B, 1, T0);
  const refused = ledger.reserve("alice", 1, T0);
  assertEquals(refused.allowed, false);
  if (!refused.allowed) assertEquals(refused.reason, "full");
  assertEquals(ledger.holds("bob", "ns", B, T0), true);
});

Deno.test("UploadLedger: reservations count toward the global cap and are never evicted", () => {
  const ledger = new UploadLedger({ maxEntries: 2 });
  const held = reserved(ledger.reserve("alice", 1, T0));
  reserved(ledger.reserve("bob", 1, T0));
  // Full of reservations: nothing recorded can make room.
  const refused = ledger.reserve("carol", 1, T0);
  assertEquals(refused.allowed, false);
  if (!refused.allowed) assertEquals(refused.reason, "full");
  // Recording a reservation never evicts.
  ledger.record(held, "ns", A, T0);
  assertEquals(ledger.size, 1);
  assertEquals(ledger.reserved, 1);
});

Deno.test("UploadLedger: many uploads stay within the global cap", () => {
  const ledger = new UploadLedger({ maxEntries: 50 });
  for (let i = 0; i < 500; i++) {
    const sha = i.toString(16).padStart(64, "0");
    const admission = ledger.reserve(`p${i % 7}`, 3, T0 + i);
    if (admission.allowed) {
      ledger.record(admission.reservation, "ns", sha, T0 + i);
    }
    if (i % 3 === 0) ledger.release("ns", [sha]);
    assertEquals(ledger.size + ledger.reserved <= 50, true);
  }
});

Deno.test("UploadLedger: refuses invalid options and sizes", () => {
  assertThrows(() => new UploadLedger({ graceMs: 0 }), RangeError);
  assertThrows(() => new UploadLedger({ maxEntries: 1.5 }), RangeError);
  assertThrows(
    () => new UploadLedger({ maxUnreferencedBytesPerPrincipal: -1 }),
    RangeError,
  );
  assertThrows(
    () => new UploadLedger({ maxEntriesPerPrincipal: 0 }),
    RangeError,
  );
  const ledger = new UploadLedger();
  assertThrows(() => ledger.reserve("alice", -1, T0), RangeError);
});

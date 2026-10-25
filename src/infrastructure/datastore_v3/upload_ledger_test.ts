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
  UploadLedger,
} from "./upload_ledger.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const T0 = 1_000_000;

Deno.test("UploadLedger: holds a recorded chunk only for its principal and namespace", () => {
  const ledger = new UploadLedger();
  ledger.record("alice", "ns1", A, 10, T0);
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
  ledger.record("alice", "ns", A, 10, T0);
  assertEquals(ledger.holds("alice", "ns", A, T0 + 999), true);
  assertEquals(ledger.holds("alice", "ns", A, T0 + 1000), false);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 1000), 0);
  assertEquals(ledger.size, 0);
});

Deno.test("UploadLedger: recording again restarts the window without double counting", () => {
  const ledger = new UploadLedger({ graceMs: 1000 });
  ledger.record("alice", "ns", A, 10, T0);
  ledger.record("alice", "ns", A, 10, T0 + 800);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 800), 10);
  assertEquals(ledger.holds("alice", "ns", A, T0 + 1500), true);
  assertEquals(ledger.size, 1);
});

Deno.test("UploadLedger: unreferencedBytes sums a principal's live, unreleased uploads", () => {
  const ledger = new UploadLedger({ graceMs: 1000 });
  ledger.record("alice", "ns", A, 10, T0);
  ledger.record("alice", "ns", B, 20, T0 + 500);
  ledger.record("bob", "ns", C, 40, T0);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 500), 30);
  assertEquals(ledger.unreferencedBytes("bob", T0 + 500), 40);
  assertEquals(ledger.unreferencedBytes("carol", T0 + 500), 0);
  // A's window ends; B's has not.
  assertEquals(ledger.unreferencedBytes("alice", T0 + 1000), 20);
});

Deno.test("UploadLedger: release stops the bytes counting but keeps the proof", () => {
  const ledger = new UploadLedger({ graceMs: 1000 });
  ledger.record("alice", "ns", A, 10, T0);
  ledger.record("bob", "ns", A, 10, T0);
  ledger.record("alice", "ns", B, 20, T0);
  ledger.record("alice", "other", A, 5, T0);
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
  ledger.record("alice", "ns", A, 10, T0);
  ledger.release("ns", [A]);
  ledger.record("alice", "ns", A, 10, T0 + 1);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 1), 10);
});

Deno.test("UploadLedger: admit refuses past the per-principal byte quota", () => {
  const ledger = new UploadLedger({
    graceMs: 1000,
    maxUnreferencedBytesPerPrincipal: 100,
  });
  assertEquals(ledger.admit("alice", 100, T0), { allowed: true });
  assertEquals(ledger.admit("alice", 101, T0).allowed, false);
  ledger.record("alice", "ns", A, 60, T0);
  assertEquals(ledger.admit("alice", 40, T0), { allowed: true });
  assertEquals(ledger.admit("alice", 41, T0), {
    allowed: false,
    reason: "bytes",
    unreferencedBytes: 60,
    limitBytes: 100,
  });
  // Other principals have their own quota.
  assertEquals(ledger.admit("bob", 100, T0), { allowed: true });
  // Releasing frees quota.
  ledger.release("ns", [A]);
  assertEquals(ledger.admit("alice", 100, T0), { allowed: true });
  // So does the window ending.
  ledger.record("alice", "ns", B, 100, T0);
  assertEquals(ledger.admit("alice", 1, T0 + 999).allowed, false);
  assertEquals(ledger.admit("alice", 1, T0 + 1000), { allowed: true });
});

Deno.test("UploadLedger: admit refuses past the per-principal entry cap", () => {
  const ledger = new UploadLedger({ maxEntriesPerPrincipal: 2 });
  ledger.record("alice", "ns", A, 0, T0);
  assertEquals(ledger.admit("alice", 0, T0), { allowed: true });
  ledger.record("alice", "ns", B, 0, T0);
  const refused = ledger.admit("alice", 0, T0);
  assertEquals(refused.allowed, false);
  if (!refused.allowed) assertEquals(refused.reason, "entries");
  assertEquals(ledger.admit("bob", 0, T0), { allowed: true });
});

Deno.test("UploadLedger: the global entry cap evicts the oldest entries", () => {
  const ledger = new UploadLedger({ maxEntries: 3 });
  ledger.record("alice", "ns", A, 1, T0);
  ledger.record("bob", "ns", B, 2, T0 + 1);
  ledger.record("alice", "ns", C, 4, T0 + 2);
  // Re-recording A moves it to the newest end, so B is now oldest.
  ledger.record("alice", "ns", A, 1, T0 + 3);
  ledger.record("carol", "ns", A, 8, T0 + 4);
  assertEquals(ledger.size, 3);
  assertEquals(ledger.holds("bob", "ns", B, T0 + 4), false);
  assertEquals(ledger.unreferencedBytes("bob", T0 + 4), 0);
  assertEquals(ledger.holds("alice", "ns", A, T0 + 4), true);
  assertEquals(ledger.holds("alice", "ns", C, T0 + 4), true);
  assertEquals(ledger.holds("carol", "ns", A, T0 + 4), true);
  assertEquals(ledger.unreferencedBytes("alice", T0 + 4), 5);
  // Evicting an entry also forgets it for release.
  ledger.record("dave", "ns", B, 16, T0 + 5);
  ledger.release("ns", [B]);
  assertEquals(ledger.unreferencedBytes("dave", T0 + 5), 0);
});

Deno.test("UploadLedger: many records stay within the entry cap", () => {
  const ledger = new UploadLedger({ maxEntries: 50 });
  for (let i = 0; i < 500; i++) {
    const sha = i.toString(16).padStart(64, "0");
    ledger.record(`p${i % 7}`, "ns", sha, 3, T0 + i);
    assertEquals(ledger.size <= 50, true);
  }
  let total = 0;
  for (let p = 0; p < 7; p++) {
    total += ledger.unreferencedBytes(`p${p}`, T0 + 500);
  }
  assertEquals(total, 50 * 3);
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
  assertThrows(() => ledger.record("alice", "ns", A, -1, T0), RangeError);
});

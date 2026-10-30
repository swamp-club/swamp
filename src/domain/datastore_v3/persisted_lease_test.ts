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
  leaderFenceOfKey,
  leasePrefixOf,
  parsePersistedLease,
  type PersistedLease,
  persistedLeaseExpiresAt,
  serializePersistedLease,
} from "./persisted_lease.ts";

const LEASE: PersistedLease = {
  leaseId: "8d7e0c39-1c7f-4b8e-9f43-7a1c5d2e9b10",
  lockKey: "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock",
  principal: "user:alice",
  fence: 3,
  holdMs: 86_400_000,
  remainingMs: 3_600_000,
  recordedAt: "2026-10-30T12:00:00.000Z",
  leaderFence: 7,
};

Deno.test("parsePersistedLease: reads back what serializePersistedLease writes", () => {
  assertEquals(parsePersistedLease(serializePersistedLease(LEASE)), LEASE);
  const pending: PersistedLease = { ...LEASE, pending: true };
  assertEquals(parsePersistedLease(serializePersistedLease(pending)), pending);
});

Deno.test("parsePersistedLease: a record that is not a lease is undefined, never trusted", () => {
  const bad: unknown[] = [
    "not json",
    [],
    null,
    { ...LEASE, fence: 0 },
    { ...LEASE, fence: 1.5 },
    { ...LEASE, holdMs: -1 },
    { ...LEASE, remainingMs: -1 },
    { ...LEASE, recordedAt: "yesterday" },
    { ...LEASE, leaseId: "" },
    { ...LEASE, principal: "x".repeat(1025) },
    { ...LEASE, leaderFence: "7" },
    { ...LEASE, pending: false },
    { ...LEASE, pending: "yes" },
  ];
  for (const value of bad) {
    const bytes = new TextEncoder().encode(
      typeof value === "string" ? value : JSON.stringify(value),
    );
    assertEquals(parsePersistedLease(bytes), undefined, JSON.stringify(value));
  }
});

Deno.test("leaderFenceOfKey: reads a leader's fence as a number, and nothing else", () => {
  assertEquals(leasePrefixOf(10), "leases/10/");
  assertEquals(leaderFenceOfKey("leases/10/complete"), 10);
  assertEquals(leaderFenceOfKey("leases/9/abc"), 9);
  for (
    const key of ["leases/x/abc", "leases/010/abc", "leases//abc", "leader/1"]
  ) {
    assertEquals(leaderFenceOfKey(key), undefined, key);
  }
});

Deno.test("persistedLeaseExpiresAt: the recording leader's time plus the hold left, plus the skew in the holder's favour", () => {
  const recorded = Date.parse(LEASE.recordedAt);
  assertEquals(
    persistedLeaseExpiresAt(LEASE, 10_000),
    recorded + 3_600_000 + 10_000,
  );
});

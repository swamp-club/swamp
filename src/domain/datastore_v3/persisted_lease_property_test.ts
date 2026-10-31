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
  leaderFenceOfKey,
  leasePrefixOf,
  parsePersistedLease,
  type PersistedLease,
  serializePersistedLease,
} from "./persisted_lease.ts";

const arbText = fc.string({ minLength: 1, maxLength: 64 });
const arbLease: fc.Arbitrary<PersistedLease> = fc.record({
  leaseId: arbText,
  lockKey: arbText,
  principal: arbText,
  fence: fc.integer({ min: 1, max: 2 ** 40 }),
  holdMs: fc.integer({ min: 1, max: 86_400_000 }),
  remainingMs: fc.integer({ min: 0, max: 86_400_000 }),
  recordedAt: fc.date({
    min: new Date("2000-01-01T00:00:00Z"),
    max: new Date("2100-01-01T00:00:00Z"),
    noInvalidDate: true,
  }).map((date) => date.toISOString()),
  leaderFence: fc.integer({ min: 1, max: 2 ** 40 }),
});

Deno.test("PersistedLease: every record round-trips through the control plane", () => {
  fc.assert(
    fc.property(arbLease, (lease) => {
      assertEquals(parsePersistedLease(serializePersistedLease(lease)), lease);
    }),
  );
});

Deno.test("leaderFenceOfKey: a prefix's fence reads back as the number it was built from", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      fc.string(),
      (fence, rest) => {
        assertEquals(leaderFenceOfKey(`${leasePrefixOf(fence)}${rest}`), fence);
      },
    ),
  );
});

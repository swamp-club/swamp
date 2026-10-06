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
  areMutuallyWaiting,
  DRAIN_WAIT_TTL_MS,
  drainToYieldTo,
  type DrainWait,
  parseDrainWait,
  serializeDrainWait,
} from "./drain_wait.ts";

const NOW = 1_800_000_000_000;

const arbLockId = fc.constantFrom("l1", "l2", "l3", "l4", "l5");

const arbDrainWait = (id: string): fc.Arbitrary<DrainWait> =>
  fc.record({
    id: fc.constant(id),
    pid: fc.integer({ min: 1, max: 4_000_000 }),
    hostname: fc.constantFrom("host-a", "host-b"),
    startedAtMs: fc.integer({ min: NOW - 5, max: NOW }),
    updatedAtMs: fc.constant(NOW),
    ttlMs: fc.constant(DRAIN_WAIT_TTL_MS),
    skipping: fc.uniqueArray(arbLockId),
    waitingOn: fc.uniqueArray(arbLockId),
  });

/** Up to five drains with distinct ids. */
const arbDrainWaits: fc.Arbitrary<DrainWait[]> = fc
  .integer({ min: 1, max: 5 })
  .chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_, i) => arbDrainWait(`drain-${i}`)),
    )
  );

const yields = (self: DrainWait, all: readonly DrainWait[]): boolean =>
  drainToYieldTo(self, all.filter((w) => w.id !== self.id), NOW) !==
    undefined;

Deno.test("DrainWait property: parse reads back any serialized wait", () => {
  fc.assert(
    fc.property(arbDrainWait("drain-0"), (wait) => {
      assertEquals(parseDrainWait(JSON.parse(serializeDrainWait(wait))), wait);
    }),
  );
});

Deno.test("DrainWait property: mutual waiting is symmetric", () => {
  fc.assert(
    fc.property(arbDrainWait("drain-0"), arbDrainWait("drain-1"), (a, b) => {
      assertEquals(areMutuallyWaiting(a, b), areMutuallyWaiting(b, a));
    }),
  );
});

Deno.test("DrainWait property: a drain yields only to one it mutually waits with, and never the reverse", () => {
  fc.assert(
    fc.property(arbDrainWaits, (waits) => {
      for (const self of waits) {
        const opponent = drainToYieldTo(
          self,
          waits.filter((w) => w.id !== self.id),
          NOW,
        );
        if (opponent !== undefined) {
          assertEquals(areMutuallyWaiting(self, opponent), true);
          assertEquals(yields(opponent, waits), false);
        }
      }
    }),
  );
});

Deno.test("DrainWait property: no two drains left waiting are mutually waiting", () => {
  fc.assert(
    fc.property(arbDrainWaits, (waits) => {
      const staying = waits.filter((w) => !yields(w, waits));
      for (const a of staying) {
        for (const b of staying) {
          if (a.id !== b.id) {
            assertEquals(areMutuallyWaiting(a, b), false);
          }
        }
      }
    }),
  );
});

Deno.test("DrainWait property: every drain reaches the same verdict whatever order it lists the others in", () => {
  fc.assert(
    fc.property(arbDrainWaits, (waits) => {
      const reversed = [...waits].reverse();
      for (const self of waits) {
        assertEquals(yields(self, waits), yields(self, reversed));
      }
    }),
  );
});

Deno.test("DrainWait property: of drains that all wait on each other exactly one keeps waiting", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 5 }), (count) => {
      const ids = Array.from({ length: count }, (_, i) => `l${i}`);
      const waits: DrainWait[] = ids.map((lockId, i) => ({
        id: `drain-${i}`,
        pid: i + 1,
        hostname: "host",
        startedAtMs: NOW - i,
        updatedAtMs: NOW,
        ttlMs: DRAIN_WAIT_TTL_MS,
        skipping: [lockId],
        waitingOn: ids.filter((other) => other !== lockId),
      }));
      assertEquals(waits.filter((w) => !yields(w, waits)).length, 1);
    }),
  );
});

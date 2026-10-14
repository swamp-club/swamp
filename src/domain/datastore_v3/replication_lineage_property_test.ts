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
  decideLineage,
  replicaPathFor,
  type ReplicationLineage,
} from "./replication_lineage.ts";

const arbStart = fc.integer({ min: 1, max: 1_000_000 });
const arbRoot = fc.constantFrom("/a", "/b");
/** A run of lease takes: each step repeats, follows or skips fences. */
const arbSteps = fc.array(
  fc.record({ gap: fc.integer({ min: 0, max: 3 }), root: arbRoot }),
  { maxLength: 40 },
);

Deno.test("decideLineage: consecutive or repeated fences under one root keep one path", () => {
  fc.assert(
    fc.property(
      arbStart,
      fc.array(fc.integer({ min: 0, max: 1 }), { maxLength: 40 }),
      (start, gaps) => {
        let record = decideLineage(undefined, "/a", start).lineage;
        let fence = start;
        for (const gap of gaps) {
          fence += gap;
          const decision = decideLineage(record, "/a", fence);
          assertEquals(decision.kind, "continue");
          record = decision.lineage;
        }
        assertEquals(
          replicaPathFor("/a", record.lineageFence),
          replicaPathFor("/a", start),
        );
      },
    ),
  );
});

Deno.test("decideLineage: lastFence never decreases and previousLineages only grows", () => {
  fc.assert(
    fc.property(arbStart, arbSteps, (start, steps) => {
      let record: ReplicationLineage = decideLineage(undefined, "/a", start)
        .lineage;
      let fence = start;
      for (const { gap, root } of steps) {
        fence += gap;
        const next = decideLineage(record, root, fence).lineage;
        assert(next.lastFence >= record.lastFence);
        assertEquals(
          next.previousLineages.slice(0, record.previousLineages.length),
          record.previousLineages,
        );
        record = next;
      }
    }),
  );
});

Deno.test("decideLineage: a gap or a root change restarts at the new fence, never on a used path", () => {
  fc.assert(
    fc.property(arbStart, arbSteps, (start, steps) => {
      let record = decideLineage(undefined, "/a", start).lineage;
      let fence = start;
      // Every replica path a lineage began on: root and fence.
      const used = new Set([`/a:${start}`]);
      for (const { gap, root } of steps) {
        fence += gap;
        const decision = decideLineage(record, root, fence);
        const continues = root === record.replicaRoot && gap <= 1;
        const expected = continues
          ? "continue"
          : used.has(`${root}:${fence}`)
          ? "conflict"
          : "restart";
        assertEquals(decision.kind, expected);
        if (expected === "restart") {
          assertEquals(decision.lineage.lineageFence, fence);
          used.add(`${root}:${fence}`);
        }
        if (expected === "conflict") assertEquals(decision.lineage, record);
        record = decision.lineage;
      }
    }),
  );
});

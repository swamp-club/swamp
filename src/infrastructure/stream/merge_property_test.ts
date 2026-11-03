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
import { mergeGated } from "./merge.ts";

const GATES = ["a", "b", "host"] as const;

interface Layout {
  limits: number[];
  streams: { gates: boolean[]; items: number; pauses: number }[];
}

const arbLayout: fc.Arbitrary<Layout> = fc.record({
  limits: fc.array(fc.integer({ min: 0, max: 4 }), {
    minLength: GATES.length,
    maxLength: GATES.length,
  }),
  streams: fc.array(
    fc.record({
      gates: fc.array(fc.boolean(), {
        minLength: GATES.length,
        maxLength: GATES.length,
      }),
      items: fc.integer({ min: 0, max: 3 }),
      pauses: fc.integer({ min: 0, max: 3 }),
    }),
    { maxLength: 10 },
  ),
});

Deno.test("mergeGated: no gate ever runs more streams than its limit, and every item arrives", async () => {
  await fc.assert(
    fc.asyncProperty(arbLayout, async (layout) => {
      const active = new Map<string, number>();
      const peak = new Map<string, number>();
      const limits = new Map<string, number>(
        GATES.map((g, i) => [g, layout.limits[i]]),
      );

      const entries = layout.streams.map((spec, s) => {
        const gates = GATES.filter((_, i) => spec.gates[i]);
        async function* run(): AsyncGenerator<string> {
          for (const gate of gates) {
            const n = (active.get(gate) ?? 0) + 1;
            active.set(gate, n);
            peak.set(gate, Math.max(peak.get(gate) ?? 0, n));
          }
          try {
            for (let i = 0; i < spec.items; i++) {
              for (let p = 0; p < spec.pauses; p++) await Promise.resolve();
              yield `${s}:${i}`;
            }
          } finally {
            for (const gate of gates) active.set(gate, active.get(gate)! - 1);
          }
        }
        return { stream: run(), gates };
      });

      const items: string[] = [];
      for await (const item of mergeGated(entries, limits)) items.push(item);

      const expected = layout.streams.flatMap((spec, s) =>
        Array.from({ length: spec.items }, (_, i) => `${s}:${i}`)
      );
      assertEquals(items.sort(), expected.sort());
      for (const [gate, n] of peak) {
        const limit = limits.get(gate)!;
        if (limit > 0) assert(n <= limit, `${gate} ran ${n} over ${limit}`);
      }
    }),
  );
});

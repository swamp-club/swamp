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
  CANNOT_COMMIT_FAILURES,
  CANNOT_COMMIT_WINDOW_MS,
  LeaderCommitHealth,
} from "./leader_commit_health.ts";

type Event =
  | { readonly kind: "full"; readonly afterMs: number }
  | { readonly kind: "locked"; readonly afterMs: number }
  | { readonly kind: "success"; readonly afterMs: number };

const arbEvent: fc.Arbitrary<Event> = fc.record({
  kind: fc.constantFrom("full", "locked", "success"),
  afterMs: fc.oneof(
    fc.constant(0),
    fc.integer({ min: 0, max: 2 * CANNOT_COMMIT_WINDOW_MS }),
  ),
}) as fc.Arbitrary<Event>;

/** the rule stated plainly: the last unbroken run of storage failures decides */
function expectTripped(events: readonly Event[]): boolean {
  let now = 0;
  let count = 0;
  let firstAt = 0;
  for (const event of events) {
    now += event.afterMs;
    if (event.kind === "success") count = 0;
    if (event.kind !== "full") continue;
    if (count === 0) firstAt = now;
    count++;
    if (
      count >= CANNOT_COMMIT_FAILURES &&
      now - firstAt >= CANNOT_COMMIT_WINDOW_MS
    ) {
      return true;
    }
  }
  return false;
}

Deno.test("LeaderCommitHealth: trips exactly when an unbroken run spans count and window", () => {
  fc.assert(
    fc.property(fc.array(arbEvent, { maxLength: 40 }), (events) => {
      let now = 0;
      const health = new LeaderCommitHealth({ now: () => now });
      for (const event of events) {
        now += event.afterMs;
        if (event.kind === "success") health.recordSuccess();
        else {
          health.recordFailure(
            new Error(
              event.kind === "full"
                ? "database or disk is full"
                : "database is locked",
            ),
          );
        }
      }
      assertEquals(health.cannotCommit() !== undefined, expectTripped(events));
    }),
  );
});

Deno.test("LeaderCommitHealth: failures all inside one window never trip", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: CANNOT_COMMIT_WINDOW_MS - 1 }), {
        maxLength: 200,
      }),
      (offsets) => {
        let now = 0;
        const health = new LeaderCommitHealth({ now: () => now });
        const start = 0;
        for (const offset of [...offsets].sort((a, b) => a - b)) {
          now = start + offset;
          health.recordFailure(new Error("database or disk is full"));
        }
        assertEquals(health.cannotCommit(), undefined);
      },
    ),
  );
});

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

import { assert } from "@std/assert";
import fc from "fast-check";
import type { AgentSessionTurn } from "./agent_sessions/record.ts";
import { fixtureSessions } from "../views/agent_sessions/fixtures.ts";
import {
  callBar,
  type CallFilter,
  callKey,
  type CallLabel,
  compressIdle,
  matchingCalls,
  STRIP_GAP_MS,
  turnEnd,
} from "./agent_session_view.ts";

const millis = fc.integer({ min: 0, max: 10_000_000 });

const turnArb: fc.Arbitrary<AgentSessionTurn> = fc.tuple(
  fc.integer({ min: 1, max: 500 }),
  millis,
  millis,
).map(([n, a, b]) => ({
  n,
  start: a,
  end: b,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  calls: [],
}));

Deno.test("compressIdle: keeps turns in order, never overlapping, never longer than they ran", () => {
  fc.assert(fc.property(fc.array(turnArb, { maxLength: 30 }), (turns) => {
    const { segments, total } = compressIdle(turns);
    let previousTo = 0;
    let lengths = 0;
    for (const s of segments) {
      assert(s.from >= previousTo && s.to >= s.from && s.idleBefore >= 0);
      assert(s.from - previousTo <= STRIP_GAP_MS);
      previousTo = s.to;
      lengths += s.to - s.from;
    }
    assert(total <= lengths + STRIP_GAP_MS * Math.max(0, turns.length - 1));
    assert(Math.max(0, ...turns.map(turnEnd)) >= 0);
  }));
});

Deno.test("callBar: always inside the turn's width, whatever the times", () => {
  fc.assert(
    fc.property(
      millis,
      millis,
      millis,
      fc.integer({ min: 1, max: 10_000_000 }),
      (start, end, at, length) => {
        const bar = callBar({ start, end }, { start: at, length });
        assert(bar.left >= 0 && bar.left <= 1);
        assert(bar.width >= 0 && bar.left + bar.width <= 1 + 1e-9);
      },
    ),
  );
});

const sessions = fixtureSessions();
const allKeys = sessions.flatMap((s) =>
  s.turns.flatMap((t) => t.calls.map((c) => callKey(s.id, c.id)))
);

const filterArb: fc.Arbitrary<CallFilter> = fc.oneof(
  fc.constant({ kind: "all" } as const),
  fc.constant({ kind: "failed" } as const),
  fc.constantFrom<CallLabel>("swamp", "bypass", "neutral", "unlabeled").map((
    label,
  ) => ({ kind: "label", label }) as const),
  fc.subarray(allKeys).map((keys) =>
    ({ kind: "calls", calls: new Set(keys) }) as const
  ),
);

Deno.test("matchingCalls: a subset of the sessions' calls, and exactly a call set's calls", () => {
  fc.assert(fc.property(filterArb, (filter) => {
    const keys = matchingCalls(filter, sessions);
    for (const key of keys) assert(allKeys.includes(key));
    if (filter.kind === "calls") {
      assert(keys.size === filter.calls.size);
      for (const key of filter.calls) assert(keys.has(key));
    }
  }));
});

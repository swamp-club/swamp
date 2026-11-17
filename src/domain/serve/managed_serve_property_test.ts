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
  ManagedServe,
  type ManagedServeEvent,
  type ManagedServePolicy,
  ROOT_SERVE,
  type WantedServeState,
} from "./managed_serve.ts";

const arbPolicy: fc.Arbitrary<ManagedServePolicy> = fc
  .integer({ min: 1, max: 100_000 })
  .chain((maxBackoffMs) =>
    fc.record({
      restartDelayMs: fc.integer({ min: 1, max: maxBackoffMs }),
      initialBackoffMs: fc.integer({ min: 1, max: maxBackoffMs }),
      maxBackoffMs: fc.constant(maxBackoffMs),
      crashWindowMs: fc.integer({ min: 1, max: 1_000_000 }),
      maxCrashesInWindow: fc.integer({ min: 1, max: 12 }),
    })
  );

const arbExitCode = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 75) },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 255 }) },
);

const arbEvent: fc.Arbitrary<ManagedServeEvent> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ kind: "tick" } as const) },
  { weight: 3, arbitrary: fc.constant({ kind: "ready" } as const) },
  {
    weight: 5,
    arbitrary: arbExitCode.map((code) => ({ kind: "exited", code }) as const),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom<WantedServeState>(
      "running",
      "suspended",
      "deleted",
    ).map((
      wanted,
    ) => ({ kind: "wanted", wanted }) as const),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "resume" } as const) },
);

const arbForwardRun = fc.record({
  policy: arbPolicy,
  events: fc.array(
    fc.tuple(arbEvent, fc.integer({ min: 0, max: 150_000 })),
    { maxLength: 200 },
  ),
});

const arbScrambledRun = fc.record({
  policy: arbPolicy,
  events: fc.array(
    fc.tuple(arbEvent, fc.integer({ min: 0, max: 2_000_000 })),
    { maxLength: 200 },
  ),
});

function snapshot(serve: ManagedServe) {
  return {
    wanted: serve.wanted,
    observed: serve.observed,
    crashCount: serve.crashCount,
    backoffMs: serve.backoffMs,
    retryAt: serve.retryAt,
    stopRequested: serve.stopRequested,
  };
}

// The harness keeps its own count of live children, from spawn actions and
// the exits that land while one runs, so the entity cannot vouch for itself.
function checkBounds(
  policy: ManagedServePolicy,
  events: ReadonlyArray<readonly [ManagedServeEvent, number]>,
  timeOf: (index: number, raw: number) => number,
  checkStep: (
    prev: ManagedServe,
    next: ManagedServe,
    event: ManagedServeEvent,
    now: number,
  ) => void,
): void {
  let serve = ManagedServe.create(ROOT_SERVE, policy);
  let live = 0;
  events.forEach(([event, raw], index) => {
    const now = timeOf(index, raw);
    const { next, action } = serve.step(event, now);

    if (event.kind === "exited" && live > 0) live--;
    if (action.kind === "spawn") {
      assertEquals(live, 0, "spawned while a child was live");
      assertEquals(next.observed, "starting");
      live++;
    }
    assertEquals(next.childLive, live === 1);

    assert(next.backoffMs <= policy.maxBackoffMs, "backoff passed its cap");
    assert(next.crashCount <= policy.maxCrashesInWindow);
    if (event.kind === "exited" && event.code === 75) {
      assert(
        next.crashCount <= serve.crashCount,
        "exit 75 raised crashCount",
      );
      assert(next.observed !== "failed" || serve.observed === "failed");
    }
    if (serve.observed === "failed" && next.observed !== "failed") {
      assertEquals(event.kind, "resume", "left failed without a resume");
    }
    if (serve.stopRequested && !next.stopRequested) {
      assertEquals(
        event.kind,
        "exited",
        "a pending stop cleared without an exit",
      );
    }
    checkStep(serve, next, event, now);
    serve = next;
  });
}

Deno.test("ManagedServe.step: random event sequences keep every invariant", () => {
  fc.assert(
    fc.property(arbForwardRun, ({ policy, events }) => {
      let clock = 0;
      checkBounds(
        policy,
        events,
        (_index, delta) => (clock += delta),
        (prev, next, event, now) => {
          const again = prev.step(event, now);
          assertEquals(snapshot(again.next), snapshot(next));
          const wait = again.action;
          if (wait.kind === "wait" && wait.until !== undefined) {
            assert(
              wait.until - now <= policy.maxBackoffMs,
              "a wait passed the backoff cap",
            );
          }
        },
      );
    }),
    { numRuns: 500 },
  );
});

Deno.test("ManagedServe.step: a clock that steps back keeps the cap and crash bounds", () => {
  fc.assert(
    fc.property(arbScrambledRun, ({ policy, events }) => {
      checkBounds(
        policy,
        events,
        (_index, time) => time,
        (prev, next, _event, now) => {
          if (next.observed === "backoff" && next.retryAt !== prev.retryAt) {
            assert(
              next.retryAt! - now <= policy.maxBackoffMs,
              "a new backoff passed its cap",
            );
          }
        },
      );
    }),
    { numRuns: 500 },
  );
});

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
  areMutuallyWaiting,
  DRAIN_WAIT_TTL_MS,
  drainToYieldTo,
  type DrainWait,
  isDrainWaitExpired,
  MAX_DRAIN_WAIT_LOCKS,
  parseDrainWait,
  serializeDrainWait,
} from "./drain_wait.ts";

const NOW = 1_800_000_000_000;

function wait(
  id: string,
  startedAtMs: number,
  skipping: string[],
  waitingOn: string[],
  overrides: Partial<DrainWait> = {},
): DrainWait {
  return {
    id,
    pid: 100,
    hostname: "host",
    startedAtMs,
    updatedAtMs: NOW,
    ttlMs: DRAIN_WAIT_TTL_MS,
    skipping,
    waitingOn,
    ...overrides,
  };
}

Deno.test("parseDrainWait: reads back what serializeDrainWait wrote", () => {
  const original = wait("drain-a", NOW - 5, ["lock-a"], ["lock-b", "lock-c"]);
  assertEquals(
    parseDrainWait(JSON.parse(serializeDrainWait(original))),
    original,
  );
});

Deno.test("parseDrainWait: rejects anything it cannot fully validate", () => {
  const valid = JSON.parse(
    serializeDrainWait(wait("drain-a", NOW, ["lock-a"], ["lock-b"])),
  );
  const tooMany = Array.from(
    { length: MAX_DRAIN_WAIT_LOCKS + 1 },
    (_, i) => `lock-${i}`,
  );
  const invalid: unknown[] = [
    null,
    "text",
    [],
    { ...valid, id: "../escape" },
    { ...valid, id: "" },
    { ...valid, pid: 0 },
    { ...valid, pid: "100" },
    { ...valid, hostname: "" },
    { ...valid, startedAtMs: -1 },
    { ...valid, updatedAtMs: 1.5 },
    { ...valid, ttlMs: 0 },
    { ...valid, ttlMs: DRAIN_WAIT_TTL_MS + 1 },
    { ...valid, skipping: "lock-a" },
    { ...valid, skipping: ["lock a"] },
    { ...valid, waitingOn: [42] },
    { ...valid, waitingOn: tooMany },
  ];
  for (const value of invalid) {
    assertEquals(parseDrainWait(value), null, JSON.stringify(value));
  }
});

Deno.test("isDrainWaitExpired: a wait expires a full ttl after its last refresh", () => {
  const published = wait("drain-a", NOW, [], [], { ttlMs: 1_000 });
  assertEquals(isDrainWaitExpired(published, NOW + 1_000), false);
  assertEquals(isDrainWaitExpired(published, NOW + 1_001), true);
});

Deno.test("areMutuallyWaiting: true only when each waits on a lock the other skips", () => {
  const a = wait("drain-a", NOW, ["lock-a"], ["lock-b"]);
  const b = wait("drain-b", NOW, ["lock-b"], ["lock-a"]);
  const bystander = wait("drain-c", NOW, ["lock-c"], ["lock-a"]);

  assertEquals(areMutuallyWaiting(a, b), true);
  assertEquals(areMutuallyWaiting(b, a), true);
  // The bystander waits on a, but a does not wait on anything it skips.
  assertEquals(areMutuallyWaiting(a, bystander), false);
});

Deno.test("drainToYieldTo: of two mutually waiting drains the later one yields", () => {
  const earlier = wait("drain-b", NOW - 10, ["lock-a"], ["lock-b"]);
  const later = wait("drain-a", NOW, ["lock-b"], ["lock-a"]);

  assertEquals(drainToYieldTo(later, [earlier], NOW), earlier);
  assertEquals(drainToYieldTo(earlier, [later], NOW), undefined);
});

Deno.test("drainToYieldTo: drains that started together are ordered by id", () => {
  const a = wait("drain-a", NOW, ["lock-a"], ["lock-b"]);
  const b = wait("drain-b", NOW, ["lock-b"], ["lock-a"]);

  assertEquals(drainToYieldTo(a, [b], NOW), undefined);
  assertEquals(drainToYieldTo(b, [a], NOW), a);
});

Deno.test("drainToYieldTo: a drain that skips the other's locks too is not in its way", () => {
  // The inner drain runs deeper inside the outer drain's run: it skips the
  // run's lock and its own step's lock. The outer drain waits on the step's
  // lock, but the inner one waits on nothing the outer skips and finishes.
  const outer = wait("drain-a", NOW - 10, ["lock-run"], ["lock-step"]);
  const inner = wait("drain-b", NOW, ["lock-run", "lock-step"], ["lock-x"]);

  assertEquals(drainToYieldTo(outer, [inner], NOW), undefined);
  assertEquals(drainToYieldTo(inner, [outer], NOW), undefined);
});

Deno.test("drainToYieldTo: ignores an expired wait", () => {
  const dead = wait("drain-a", NOW - 60_000, ["lock-a"], ["lock-b"], {
    updatedAtMs: NOW - DRAIN_WAIT_TTL_MS - 1,
  });
  const self = wait("drain-b", NOW, ["lock-b"], ["lock-a"]);

  assertEquals(drainToYieldTo(self, [dead], NOW), undefined);
});

Deno.test("drainToYieldTo: ignores its own marker among the others", () => {
  const self = wait("drain-a", NOW, ["lock-a"], ["lock-a"]);

  assertEquals(drainToYieldTo(self, [self], NOW), undefined);
});

Deno.test("drainToYieldTo: of three mutually waiting drains only the first keeps waiting", () => {
  const first = wait("drain-1", NOW - 20, ["lock-1"], ["lock-2", "lock-3"]);
  const second = wait("drain-2", NOW - 10, ["lock-2"], ["lock-1", "lock-3"]);
  const third = wait("drain-3", NOW, ["lock-3"], ["lock-1", "lock-2"]);

  assertEquals(drainToYieldTo(first, [second, third], NOW), undefined);
  assertEquals(drainToYieldTo(second, [first, third], NOW), first);
  assertEquals(drainToYieldTo(third, [first, second], NOW), first);
});

Deno.test("drainToYieldTo: does not yield to a drain that is itself yielding", () => {
  // first and second wait on each other, as do second and third, but first
  // and third do not: third runs inside first's run. Second yields to
  // first, which leaves nothing in third's way.
  const first = wait("drain-1", NOW - 20, ["lock-1", "lock-3"], ["lock-2"]);
  const second = wait("drain-2", NOW - 10, ["lock-2"], ["lock-1", "lock-3"]);
  const third = wait("drain-3", NOW, ["lock-3"], ["lock-1", "lock-2"]);

  assertEquals(areMutuallyWaiting(first, third), false);
  assertEquals(drainToYieldTo(second, [first, third], NOW), first);
  assertEquals(drainToYieldTo(third, [first, second], NOW), undefined);
});

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
  chooseLatest,
  correctedExecutionTime,
  LATEST_WINDOW_MS,
  observationTimeOf,
  restatedVersionOf,
  RESTATES_TAG,
  sourceVersionOf,
  type VersionObservation,
} from "./latest_choice.ts";

const T0 = Date.parse("2026-10-30T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function lookupOf(entries: Record<number, VersionObservation>) {
  return (version: number) => entries[version];
}

Deno.test("chooseLatest: a write observed more than the window later wins", () => {
  assertEquals(
    chooseLatest({
      rebasedObservedAt: T0 + LATEST_WINDOW_MS + 1,
      currentObservedAt: T0,
    }),
    "rebased",
  );
});

Deno.test("chooseLatest: inside the window, at its edge, or earlier the current latest stays", () => {
  for (
    const delta of [
      LATEST_WINDOW_MS,
      LATEST_WINDOW_MS - 1,
      0,
      -LATEST_WINDOW_MS * 4,
    ]
  ) {
    assertEquals(
      chooseLatest({ rebasedObservedAt: T0 + delta, currentObservedAt: T0 }),
      "current",
    );
  }
});

Deno.test("chooseLatest: no current latest, or none with a time, takes the rebased version", () => {
  assertEquals(
    chooseLatest({ rebasedObservedAt: T0, currentObservedAt: undefined }),
    "rebased",
  );
  assertEquals(
    chooseLatest({
      rebasedObservedAt: undefined,
      currentObservedAt: undefined,
    }),
    "rebased",
  );
});

Deno.test("chooseLatest: a write with no time never displaces a latest with one", () => {
  assertEquals(
    chooseLatest({ rebasedObservedAt: undefined, currentObservedAt: T0 }),
    "current",
  );
});

Deno.test("correctedExecutionTime: adds the clock offset, ignores an unknown one", () => {
  assertEquals(correctedExecutionTime(iso(T0), 1500), T0 + 1500);
  assertEquals(correctedExecutionTime(iso(T0)), T0);
  assertEquals(correctedExecutionTime(iso(T0), NaN), T0);
  assertEquals(correctedExecutionTime("not a time", 10), undefined);
});

Deno.test("restatedVersionOf: reads only a positive integer under the reserved key", () => {
  assertEquals(restatedVersionOf({ [RESTATES_TAG]: "4" }), 4);
  assertEquals(restatedVersionOf({ restates: "4" }), undefined);
  assertEquals(restatedVersionOf({ [RESTATES_TAG]: "0" }), undefined);
  assertEquals(restatedVersionOf({ [RESTATES_TAG]: "04" }), undefined);
  assertEquals(
    restatedVersionOf({ [RESTATES_TAG]: "2026-10-30T10:00:00Z" }),
    undefined,
  );
  assertEquals(restatedVersionOf(undefined), undefined);
});

Deno.test("sourceVersionOf: follows a chain of restatements and stops at a loop or a gap", () => {
  const created = iso(T0);
  const chain = lookupOf({
    1: { createdAt: created },
    3: { createdAt: created, tags: { [RESTATES_TAG]: "1" } },
    5: { createdAt: created, tags: { [RESTATES_TAG]: "3" } },
  });
  assertEquals(sourceVersionOf(5, chain), 1);
  const loop = lookupOf({
    2: { createdAt: created, tags: { [RESTATES_TAG]: "4" } },
    4: { createdAt: created, tags: { [RESTATES_TAG]: "2" } },
  });
  assertEquals(sourceVersionOf(2, loop), 4);
  const gap = lookupOf({
    6: { createdAt: created, tags: { [RESTATES_TAG]: "9" } },
  });
  assertEquals(sourceVersionOf(6, gap), 6);
});

Deno.test("observationTimeOf: the earlier of the source's commit time and createdAt, createdAt alone once compacted", () => {
  const lookup = lookupOf({
    1: { committedAt: iso(T0), createdAt: iso(T0 + 1000) },
    4: { committedAt: iso(T0), createdAt: iso(T0 - 1000) },
    2: {
      committedAt: iso(T0 + 3_600_000),
      createdAt: iso(T0 + 3_600_000),
      tags: { [RESTATES_TAG]: "1" },
    },
    3: { createdAt: iso(T0 - 5000) },
  });
  assertEquals(observationTimeOf(2, lookup), T0);
  assertEquals(observationTimeOf(4, lookup), T0 - 1000);
  assertEquals(observationTimeOf(3, lookup), T0 - 5000);
  assertEquals(observationTimeOf(7, lookup), undefined);
});

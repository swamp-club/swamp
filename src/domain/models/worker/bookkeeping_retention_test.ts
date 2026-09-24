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
  isReapableDispatch,
  isReapableLease,
} from "./bookkeeping_retention.ts";

const GRACE = 24 * 60 * 60 * 1000;
const ENDED_AT = "2026-09-01T00:00:00.000Z";
const ENDED_MS = Date.parse(ENDED_AT);

function lease(overrides: Record<string, unknown> = {}) {
  return {
    leaseId: "l1",
    dispatchId: "d1",
    workerName: "w1",
    modelType: "command/shell",
    modelId: "m1",
    methodName: "execute",
    state: "completed",
    hasWrites: false,
    createdAt: "2026-08-31T23:59:00.000Z",
    endedAt: ENDED_AT,
    ...overrides,
  };
}

function dispatch(overrides: Record<string, unknown> = {}) {
  return {
    queueId: "q1",
    state: "dispatched",
    modelType: "command/shell",
    methodName: "execute",
    queuedAt: "2026-08-31T23:59:00.000Z",
    endedAt: ENDED_AT,
    ...overrides,
  };
}

for (const state of ["completed", "failed", "expired"]) {
  Deno.test(`isReapableLease: ${state} lease is reapable exactly at the grace boundary`, () => {
    assertEquals(
      isReapableLease(lease({ state }), GRACE, ENDED_MS + GRACE),
      true,
    );
  });

  Deno.test(`isReapableLease: ${state} lease is kept 1ms before the grace boundary`, () => {
    assertEquals(
      isReapableLease(lease({ state }), GRACE, ENDED_MS + GRACE - 1),
      false,
    );
  });
}

Deno.test("isReapableLease: active lease is never reapable, however old", () => {
  assertEquals(
    isReapableLease(
      lease({ state: "active" }),
      GRACE,
      ENDED_MS + 365 * GRACE,
    ),
    false,
  );
});

Deno.test("isReapableLease: ended lease without endedAt is kept", () => {
  const { endedAt: _endedAt, ...noEnd } = lease();
  assertEquals(isReapableLease(noEnd, GRACE, ENDED_MS + 365 * GRACE), false);
});

Deno.test("isReapableLease: unparseable endedAt is kept", () => {
  assertEquals(
    isReapableLease(
      lease({ endedAt: "not-a-date" }),
      GRACE,
      ENDED_MS + 365 * GRACE,
    ),
    false,
  );
});

Deno.test("isReapableLease: schema-invalid record is kept", () => {
  assertEquals(
    isReapableLease(
      { state: "completed", endedAt: ENDED_AT },
      GRACE,
      ENDED_MS + GRACE,
    ),
    false,
  );
  assertEquals(isReapableLease(null, GRACE, ENDED_MS + GRACE), false);
});

for (const state of ["dispatched", "timed_out", "cancelled", "orphaned"]) {
  Deno.test(`isReapableDispatch: ${state} dispatch is reapable exactly at the grace boundary`, () => {
    assertEquals(
      isReapableDispatch(dispatch({ state }), GRACE, ENDED_MS + GRACE),
      true,
    );
  });

  Deno.test(`isReapableDispatch: ${state} dispatch is kept 1ms before the grace boundary`, () => {
    assertEquals(
      isReapableDispatch(dispatch({ state }), GRACE, ENDED_MS + GRACE - 1),
      false,
    );
  });
}

Deno.test("isReapableDispatch: waiting dispatch is never reapable, however old", () => {
  assertEquals(
    isReapableDispatch(
      dispatch({ state: "waiting", endedAt: undefined }),
      GRACE,
      ENDED_MS + 365 * GRACE,
    ),
    false,
  );
  // A waiting record carrying a stray endedAt is still live.
  assertEquals(
    isReapableDispatch(
      dispatch({ state: "waiting" }),
      GRACE,
      ENDED_MS + 365 * GRACE,
    ),
    false,
  );
});

Deno.test("isReapableDispatch: ended dispatch without endedAt is kept", () => {
  const { endedAt: _endedAt, ...noEnd } = dispatch();
  assertEquals(isReapableDispatch(noEnd, GRACE, ENDED_MS + 365 * GRACE), false);
});

Deno.test("isReapableDispatch: schema-invalid record is kept", () => {
  assertEquals(
    isReapableDispatch(
      { state: "orphaned", endedAt: ENDED_AT },
      GRACE,
      ENDED_MS + GRACE,
    ),
    false,
  );
});

Deno.test("isReapableLease: a dispatch record is not a reapable lease", () => {
  assertEquals(isReapableLease(dispatch(), GRACE, ENDED_MS + GRACE), false);
});

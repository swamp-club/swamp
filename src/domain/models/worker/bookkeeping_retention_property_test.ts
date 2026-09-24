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
import { z } from "zod";
import {
  isReapableDispatch,
  isReapableLease,
} from "./bookkeeping_retention.ts";
import { LeaseStateSchema, TERMINAL_LEASE_STATES } from "./step_lease_model.ts";
import {
  PendingDispatchStateSchema,
  TERMINAL_PENDING_DISPATCH_STATES,
} from "./pending_dispatch_model.ts";

const MIN_MS = Date.parse("2020-01-01T00:00:00.000Z");
const MAX_MS = Date.parse("2035-01-01T00:00:00.000Z");

const arbMs = fc.integer({ min: MIN_MS, max: MAX_MS });
const arbGrace = fc.integer({ min: 0, max: 30 * 24 * 60 * 60 * 1000 });
/**
 * endedAt: absent, a valid ISO timestamp (with or without milliseconds), or
 * garbage.
 */
const arbEndedAt = fc.oneof(
  fc.constant(undefined),
  arbMs.map((ms) => new Date(ms).toISOString()),
  arbMs.map((ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")),
  fc.string(),
);

/** The schema's own notion of a well-formed timestamp. */
const isDatetime = (value: string) =>
  z.string().datetime().safeParse(value).success;

function expectedReapable(
  terminal: boolean,
  endedAt: string | undefined,
  grace: number,
  now: number,
): boolean {
  if (!terminal || endedAt === undefined) return false;
  // Garbage strings fail the schema's datetime check before any parse.
  if (!isDatetime(endedAt)) return false;
  return now - Date.parse(endedAt) >= grace;
}

Deno.test("isReapableLease property: reapable iff terminal, well-formed endedAt and aged past grace", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...LeaseStateSchema.options),
      arbEndedAt,
      arbGrace,
      arbMs,
      (state, endedAt, grace, now) => {
        const record = {
          leaseId: "l",
          dispatchId: "d",
          workerName: "w",
          modelType: "t",
          modelId: "m",
          methodName: "x",
          state,
          hasWrites: false,
          createdAt: new Date(MIN_MS).toISOString(),
          ...(endedAt !== undefined ? { endedAt } : {}),
        };
        const reapable = isReapableLease(record, grace, now);
        assertEquals(
          reapable,
          expectedReapable(
            TERMINAL_LEASE_STATES.has(state),
            endedAt,
            grace,
            now,
          ),
        );
        if (state === "active") assert(!reapable);
      },
    ),
  );
});

Deno.test("isReapableDispatch property: reapable iff terminal, well-formed endedAt and aged past grace", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...PendingDispatchStateSchema.options),
      arbEndedAt,
      arbGrace,
      arbMs,
      (state, endedAt, grace, now) => {
        const record = {
          queueId: "q",
          state,
          modelType: "t",
          methodName: "x",
          queuedAt: new Date(MIN_MS).toISOString(),
          ...(endedAt !== undefined ? { endedAt } : {}),
        };
        const reapable = isReapableDispatch(record, grace, now);
        assertEquals(
          reapable,
          expectedReapable(
            TERMINAL_PENDING_DISPATCH_STATES.has(state),
            endedAt,
            grace,
            now,
          ),
        );
        if (state === "waiting") assert(!reapable);
      },
    ),
  );
});

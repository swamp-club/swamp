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
  endedLease,
  type EndedLeaseState,
  recordLeaseWrites,
  startLease,
  type StepLease,
  TERMINAL_LEASE_STATES,
} from "./step_lease_model.ts";

type Operation =
  | { kind: "mark_writes" }
  | { kind: "end"; state: EndedLeaseState; error?: string };

const arbOperation: fc.Arbitrary<Operation> = fc.oneof(
  fc.constant({ kind: "mark_writes" as const }),
  fc.record({
    kind: fc.constant("end" as const),
    state: fc.constantFrom<EndedLeaseState>("completed", "failed", "expired"),
    error: fc.option(fc.string(), { nil: undefined }),
  }),
);

const NOW = new Date("2026-10-27T12:00:00.000Z");

/** Applies `op`, returning the lease unchanged when the operation is refused. */
function apply(lease: StepLease, op: Operation): StepLease {
  try {
    if (op.kind === "mark_writes") {
      return recordLeaseWrites(lease.leaseId, lease) ?? lease;
    }
    return endedLease(lease.leaseId, lease, op.state, op.error, NOW);
  } catch {
    return lease;
  }
}

Deno.test("step lease property: an ended lease is never rewritten, and hasWrites never reverts", () => {
  fc.assert(
    fc.property(fc.array(arbOperation, { maxLength: 12 }), (ops) => {
      let lease = startLease(
        {
          leaseId: "l",
          dispatchId: "d",
          workerName: "w",
          modelType: "t",
          modelId: "m",
          methodName: "x",
        },
        null,
        NOW,
      );
      let firstEnd: StepLease | undefined;
      for (const op of ops) {
        const before = lease;
        lease = apply(lease, op);
        if (TERMINAL_LEASE_STATES.has(before.state)) {
          assertEquals(lease, before);
        }
        if (before.hasWrites) assert(lease.hasWrites);
        if (firstEnd === undefined && TERMINAL_LEASE_STATES.has(lease.state)) {
          firstEnd = lease;
        }
      }
      if (firstEnd !== undefined) assertEquals(lease, firstEnd);
    }),
  );
});

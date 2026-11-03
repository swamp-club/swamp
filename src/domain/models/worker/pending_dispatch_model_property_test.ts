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
  endedPendingDispatch,
  type EnqueuePendingArgs,
  PENDING_DISPATCH_END_METHODS,
  PENDING_DISPATCH_INSTANCE_NAME,
  PENDING_DISPATCH_MODEL_TYPE,
  pendingDataName,
  type PendingDispatchEnd,
  pendingDispatchModel,
  PendingDispatchSchema,
  startPendingDispatch,
  TERMINAL_PENDING_DISPATCH_STATES,
} from "./pending_dispatch_model.ts";
import { createInMemoryWorkerContext } from "./worker_test_helpers.ts";

const arbIso = fc.date({
  min: new Date("2026-01-01T00:00:00.000Z"),
  max: new Date("2027-01-01T00:00:00.000Z"),
  noInvalidDate: true,
}).map((d) => d.toISOString());

const arbArgs: fc.Arbitrary<EnqueuePendingArgs> = fc.record({
  queueId: fc.uuid(),
  target: fc.string({ minLength: 1 }),
  labels: fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
  platform: fc.constantFrom("linux", "darwin"),
  workflowName: fc.string({ minLength: 1 }),
  jobName: fc.string({ minLength: 1 }),
  stepName: fc.string({ minLength: 1 }),
  modelType: fc.constantFrom("command/shell", "@acme/widget"),
  methodName: fc.constantFrom("execute", "create"),
  queuedAt: arbIso,
}, { requiredKeys: ["queueId", "modelType", "methodName", "queuedAt"] });

const arbEnd: fc.Arbitrary<PendingDispatchEnd> = fc.oneof(
  fc.record({
    state: fc.constant("dispatched" as const),
    dispatchId: fc.uuid(),
    endedAt: arbIso,
  }),
  fc.record({
    state: fc.constantFrom(
      "timed_out" as const,
      "cancelled" as const,
      "orphaned" as const,
    ),
    endedAt: arbIso,
  }),
);

function methodInputs(queueId: string, end: PendingDispatchEnd) {
  const { state: _state, ...fields } = end;
  return { queueId, ...fields };
}

Deno.test("pending dispatch transitions: the first end wins and later ends change nothing", () => {
  fc.assert(
    fc.property(
      arbArgs,
      fc.array(arbEnd, { minLength: 1, maxLength: 5 }),
      (args, ends) => {
        let record = startPendingDispatch(args, null);
        for (const end of ends) {
          record = endedPendingDispatch(record, end) ?? record;
        }
        const first = ends[0];
        assertEquals(
          record,
          PendingDispatchSchema.parse({ ...args, ...first }),
        );
        assertEquals(TERMINAL_PENDING_DISPATCH_STATES.has(record.state), true);
      },
    ),
  );
});

Deno.test("pending dispatch transitions: the methods write exactly what the pure functions return", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbArgs,
      fc.array(arbEnd, { minLength: 1, maxLength: 4 }),
      async (args, ends) => {
        const { context, store } = createInMemoryWorkerContext(
          PENDING_DISPATCH_MODEL_TYPE,
          PENDING_DISPATCH_INSTANCE_NAME,
        );
        await pendingDispatchModel.methods.enqueue.execute(args, context);
        let expected = startPendingDispatch(args, null);
        assertEquals(store.get(pendingDataName(args.queueId)), expected);
        for (const end of ends) {
          await pendingDispatchModel.methods[
            PENDING_DISPATCH_END_METHODS[end.state]
          ].execute(methodInputs(args.queueId, end), context);
          expected = endedPendingDispatch(expected, end) ?? expected;
          assertEquals(store.get(pendingDataName(args.queueId)), expected);
        }
      },
    ),
  );
});

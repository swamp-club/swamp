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
  nextWorkerState,
  type SetStatusArgs,
  type WorkerState,
  type WorkerStatus,
} from "./worker_model.ts";

const arbStatus = fc.constantFrom<WorkerStatus>(
  "idle",
  "busy",
  "disconnected",
  "unverified",
  "draining",
);

const arbIds = fc.array(fc.uuid(), { maxLength: 4 });

const arbState: fc.Arbitrary<WorkerState> = fc.record({
  name: fc.constant("w1"),
  instanceUuid: fc.uuid(),
  tokenName: fc.constant("w1"),
  status: arbStatus,
  labels: fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
  platform: fc.constant("linux"),
  arch: fc.constant("x86_64"),
  swampVersion: fc.constant("1.0.0"),
  protocolVersion: fc.integer({ min: 1, max: 9 }),
  enrolledAt: fc.constant("2026-11-01T00:00:00.000Z"),
  lastSeenAt: fc.constant("2026-11-01T00:00:00.000Z"),
  capacity: fc.integer({ min: 1, max: 16 }),
  activeDispatchIds: arbIds,
  disconnectedAt: fc.constant("2026-11-01T12:00:00.000Z"),
  verifyFailureReason: fc.string(),
}, {
  requiredKeys: [
    "name",
    "instanceUuid",
    "tokenName",
    "status",
    "labels",
    "platform",
    "arch",
    "swampVersion",
    "protocolVersion",
    "enrolledAt",
    "lastSeenAt",
    "capacity",
    "activeDispatchIds",
  ],
});

const arbArgs: fc.Arbitrary<SetStatusArgs> = fc.record({
  status: arbStatus,
  activeDispatchIds: fc.option(arbIds, { nil: undefined }),
  verifyFailureReason: fc.option(fc.string(), { nil: undefined }),
}, { requiredKeys: ["status"] });

const NOW = new Date("2026-11-02T10:00:00.000Z");

Deno.test("nextWorkerState: any status change keeps the worker's identity and records its status and time", () => {
  fc.assert(
    fc.property(arbState, arbArgs, (current, args) => {
      const next = nextWorkerState(current, args, NOW);
      assertEquals(next.status, args.status);
      assertEquals(next.lastSeenAt, NOW.toISOString());
      for (
        const key of [
          "name",
          "instanceUuid",
          "tokenName",
          "labels",
          "platform",
          "arch",
          "swampVersion",
          "protocolVersion",
          "enrolledAt",
          "capacity",
        ] as const
      ) {
        assertEquals(next[key], current[key]);
      }
    }),
  );
});

Deno.test("nextWorkerState: idle and disconnected hold no dispatches; other statuses hold the given ones, else the current ones", () => {
  fc.assert(
    fc.property(arbState, arbArgs, (current, args) => {
      const next = nextWorkerState(current, args, NOW);
      if (args.status === "idle" || args.status === "disconnected") {
        assertEquals(next.activeDispatchIds, []);
      } else {
        assertEquals(
          next.activeDispatchIds,
          args.activeDispatchIds ?? current.activeDispatchIds,
        );
      }
    }),
  );
});

Deno.test("nextWorkerState: only unverified carries a failure reason, and only disconnected stamps disconnectedAt", () => {
  fc.assert(
    fc.property(arbState, arbArgs, (current, args) => {
      const next = nextWorkerState(current, args, NOW);
      if (args.status === "unverified") {
        assertEquals(next.verifyFailureReason, args.verifyFailureReason);
      } else {
        assert(next.verifyFailureReason === undefined);
      }
      assertEquals(
        next.disconnectedAt,
        args.status === "disconnected"
          ? NOW.toISOString()
          : current.disconnectedAt,
      );
    }),
  );
});

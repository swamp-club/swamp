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
/**
 * Properties of the sidecar's replica checks (swamp-club#3935): a verdict
 * that covers what the writer acknowledged is never checked again, and a
 * sidecar about to idle out always reaches its exit, however its checks end.
 */

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  REPLICA_VERIFY_INTERVAL_MS,
  type ReplicaVerification,
  shouldVerifyReplica,
} from "./replica_verification.ts";

const arbTxid = fc.integer({ min: 1, max: 0xffff }).map((n) =>
  n.toString(16).padStart(16, "0")
);
const arbFence = fc.integer({ min: 1, max: 20 });

Deno.test("shouldVerifyReplica (property): a verdict on the acknowledged TXID of the same lineage is never checked again", () => {
  fc.assert(
    fc.property(
      arbFence,
      arbTxid,
      fc.boolean(),
      fc.boolean(),
      fc.option(fc.integer({ min: 0, max: 10 * REPLICA_VERIFY_INTERVAL_MS })),
      (fence, txid, ok, idle, startedAgo) => {
        const last: ReplicaVerification = {
          lineageFence: fence,
          txid,
          checkedAt: "2026-10-25T00:00:00.000Z",
          ok,
        };
        const now = 100 * REPLICA_VERIFY_INTERVAL_MS;
        assertEquals(
          shouldVerifyReplica({
            lineageFence: fence,
            acknowledgedTxid: txid.replace(/^0+/, ""),
            last,
            lastStartedAtMs: startedAgo === null ? undefined : now - startedAgo,
            lastAttemptedTxid: undefined,
            nowMs: now,
            idle,
            intervalMs: REPLICA_VERIFY_INTERVAL_MS,
          }),
          false,
        );
      },
    ),
  );
});

Deno.test("shouldVerifyReplica (property): an idle sidecar checks each TXID at most once, so it always reaches its exit", () => {
  fc.assert(
    fc.property(
      arbFence,
      arbTxid,
      // Each check ends with a verdict (true) or without one (false).
      fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
      (fence, txid, outcomes) => {
        let last: ReplicaVerification | undefined;
        let lastStartedAtMs: number | undefined;
        let lastAttemptedTxid: string | undefined;
        let now = 0;
        let checks = 0;
        for (const recorded of outcomes) {
          now += 1;
          const due = shouldVerifyReplica({
            lineageFence: fence,
            acknowledgedTxid: txid,
            last,
            lastStartedAtMs,
            lastAttemptedTxid,
            nowMs: now,
            idle: true,
            intervalMs: REPLICA_VERIFY_INTERVAL_MS,
          });
          if (!due) continue;
          checks++;
          lastStartedAtMs = now;
          lastAttemptedTxid = txid;
          if (recorded) {
            last = {
              lineageFence: fence,
              txid,
              checkedAt: "2026-10-25T00:00:00.000Z",
              ok: true,
            };
          }
        }
        assert(checks <= 1);
      },
    ),
  );
});

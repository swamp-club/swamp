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
 * Properties of the sidecar's replica checks (swamp-club#3935,
 * swamp-club#4261): a verdict that covers what the writer acknowledged is
 * never checked again, a sidecar about to idle out always reaches its exit
 * however its checks end, and neither steady writes nor a run of short-lived
 * sidecars restores more often than its triggers allow.
 */

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  REPLICA_VERIFY_BACKSTOP_MS,
  REPLICA_VERIFY_RETRY_MS,
  type ReplicaVerification,
  type ReplicaVerifyAttempt,
  shouldVerifyReplica,
} from "./replica_verification.ts";

const arbTxid = fc.integer({ min: 1, max: 0xffff }).map((n) =>
  n.toString(16).padStart(16, "0")
);
const arbFence = fc.integer({ min: 1, max: 20 });
const txid = (n: number) => n.toString(16).padStart(16, "0");

Deno.test("shouldVerifyReplica (property): a verdict on the acknowledged TXID of the same lineage is never checked again", () => {
  fc.assert(
    fc.property(
      arbFence,
      arbTxid,
      fc.boolean(),
      fc.option(arbTxid),
      fc.option(arbTxid),
      fc.integer({ min: 0, max: 10 * REPLICA_VERIFY_BACKSTOP_MS }),
      (fence, acked, ok, recordedSnapshot, snapshot, elapsed) => {
        const last: ReplicaVerification = {
          lineageFence: fence,
          txid: acked,
          checkedAt: new Date(0).toISOString(),
          ok,
          ...(recordedSnapshot !== null
            ? { snapshotTxid: recordedSnapshot }
            : {}),
        };
        assertEquals(
          shouldVerifyReplica({
            lineageFence: fence,
            acknowledgedTxid: acked.replace(/^0+/, ""),
            last,
            snapshotTxid: snapshot ?? undefined,
            lastAttempt: undefined,
            nowMs: elapsed,
            backstopMs: REPLICA_VERIFY_BACKSTOP_MS,
            retryMs: REPLICA_VERIFY_RETRY_MS,
          }),
          false,
        );
      },
    ),
  );
});

Deno.test("shouldVerifyReplica (property): a new lineage is always checked by a sidecar that has not tried yet", () => {
  fc.assert(
    fc.property(
      arbFence,
      arbTxid,
      fc.option(arbTxid),
      fc.integer({ min: 0, max: 10 * REPLICA_VERIFY_BACKSTOP_MS }),
      (fence, acked, snapshot, now) => {
        assert(
          shouldVerifyReplica({
            lineageFence: fence,
            acknowledgedTxid: acked,
            last: {
              lineageFence: fence + 1,
              txid: acked,
              checkedAt: new Date(now).toISOString(),
              ok: true,
            },
            snapshotTxid: snapshot ?? undefined,
            lastAttempt: undefined,
            nowMs: now,
            backstopMs: REPLICA_VERIFY_BACKSTOP_MS,
            retryMs: REPLICA_VERIFY_RETRY_MS,
          }),
        );
      },
    ),
  );
});

Deno.test("shouldVerifyReplica (property): a sidecar checks at most once per snapshot it sees within the retry delay, so it always reaches its exit", () => {
  fc.assert(
    fc.property(
      arbFence,
      arbTxid,
      fc.option(arbTxid),
      // Each check ends with a verdict (true) or without one (false).
      fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
      (fence, acked, snapshot, outcomes) => {
        let last: ReplicaVerification | undefined;
        let lastAttempt: ReplicaVerifyAttempt | undefined;
        let now = 0;
        let checks = 0;
        for (const recorded of outcomes) {
          now += 1000;
          const due = shouldVerifyReplica({
            lineageFence: fence,
            acknowledgedTxid: acked,
            last,
            snapshotTxid: snapshot ?? undefined,
            lastAttempt,
            nowMs: now,
            backstopMs: REPLICA_VERIFY_BACKSTOP_MS,
            retryMs: REPLICA_VERIFY_RETRY_MS,
          });
          if (!due) continue;
          checks++;
          lastAttempt = {
            startedAtMs: now,
            snapshotTxid: snapshot ?? undefined,
          };
          if (recorded) {
            last = {
              lineageFence: fence,
              txid: acked,
              checkedAt: new Date(now).toISOString(),
              ok: true,
              ...(snapshot !== null ? { snapshotTxid: snapshot } : {}),
            };
          }
        }
        assert(checks <= 1);
      },
    ),
  );
});

/**
 * Simulates `hours` of a writer that acknowledges a new TXID every minute,
 * served by one sidecar after another: each lives `sidecarMinutes` and
 * evaluates the rule every minute (its last minute is its idle exit). The
 * replica's snapshot changes at the given hours. Checks always record a
 * verdict. Resolves with how many restores ran.
 */
function simulate(
  hours: number,
  sidecarMinutes: number,
  snapshotHours: readonly number[],
): number {
  const minute = 60_000;
  let last: ReplicaVerification | undefined;
  let lastAttempt: ReplicaVerifyAttempt | undefined;
  let restores = 0;
  for (let m = 0; m < hours * 60; m++) {
    // A new sidecar forgets its predecessor's attempt.
    if (m % sidecarMinutes === 0) lastAttempt = undefined;
    const now = m * minute;
    const snapshot = txid(
      1 + snapshotHours.filter((h) => h * 60 <= m).length,
    );
    const acked = txid(100 + m);
    if (
      shouldVerifyReplica({
        lineageFence: 1,
        acknowledgedTxid: acked,
        last,
        snapshotTxid: snapshot,
        lastAttempt,
        nowMs: now,
        backstopMs: REPLICA_VERIFY_BACKSTOP_MS,
        retryMs: REPLICA_VERIFY_RETRY_MS,
      })
    ) {
      restores++;
      lastAttempt = { startedAtMs: now, snapshotTxid: snapshot };
      last = {
        lineageFence: 1,
        txid: acked,
        checkedAt: new Date(now).toISOString(),
        ok: true,
        snapshotTxid: snapshot,
      };
    }
  }
  return restores;
}

Deno.test("shouldVerifyReplica (property): steady writes restore at most once per backstop plus once per new lineage and snapshot", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 48 }),
      // One long-lived serve sidecar, or CLI sidecars that idle out after
      // 5 minutes, and anything between.
      fc.integer({ min: 5, max: 48 * 60 }),
      fc.uniqueArray(fc.integer({ min: 1, max: 47 }), { maxLength: 3 }),
      (hours, sidecarMinutes, snapshotHours) => {
        const snapshots = snapshotHours.filter((h) => h < hours).length;
        const bound = 1 + snapshots + Math.ceil(hours / 4);
        assert(simulate(hours, sidecarMinutes, snapshotHours) <= bound);
      },
    ),
  );
});

Deno.test("shouldVerifyReplica: a day of 5-minute CLI sidecars restores about 6 times, not 144", () => {
  // The new lineage, one daily snapshot, and the 4-hour backstop.
  assertEquals(simulate(24, 5, [12]) <= 1 + 1 + 6, true);
  assertEquals(simulate(24, 24 * 60, []) <= 1 + 6, true);
});

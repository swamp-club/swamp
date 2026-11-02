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
  REPLICA_VERIFY_BACKSTOP_MS,
  REPLICA_VERIFY_RETRY_MS,
  type ReplicaVerification,
  type ReplicaVerifyAttempt,
  shouldVerifyReplica,
  snapshotReadAt,
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
            idle: false,
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
            idle: false,
            backstopMs: REPLICA_VERIFY_BACKSTOP_MS,
            retryMs: REPLICA_VERIFY_RETRY_MS,
          }),
        );
      },
    ),
  );
});

Deno.test("shouldVerifyReplica (property): an idle sidecar checks each acknowledged TXID at most once, however long its checks run and however they end, so it always reaches its exit", () => {
  fc.assert(
    fc.property(
      arbFence,
      arbTxid,
      fc.array(
        fc.record({
          durationMs: fc.integer({ min: 0, max: 40 * 60_000 }),
          recorded: fc.boolean(),
          snapshot: fc.option(fc.integer({ min: 1, max: 4 })),
        }),
        { minLength: 1, maxLength: 30 },
      ),
      fc.option(fc.boolean()),
      (fence, acked, ticks, startCovered) => {
        let last: ReplicaVerification | undefined = startCovered === null
          ? undefined
          : {
            lineageFence: fence,
            txid: "0000000000000000",
            checkedAt: new Date(0).toISOString(),
            ok: true,
          };
        let lastAttempt: ReplicaVerifyAttempt | undefined;
        let now = REPLICA_VERIFY_BACKSTOP_MS;
        let checks = 0;
        for (const tick of ticks) {
          now += 2_000;
          const snapshotTxid = tick.snapshot === null
            ? undefined
            : txid(tick.snapshot);
          const due = shouldVerifyReplica({
            lineageFence: fence,
            acknowledgedTxid: acked,
            last,
            snapshotTxid,
            lastAttempt,
            nowMs: now,
            idle: true,
            backstopMs: REPLICA_VERIFY_BACKSTOP_MS,
            retryMs: REPLICA_VERIFY_RETRY_MS,
          });
          if (!due) continue;
          checks++;
          const startedAtMs = now;
          now += tick.durationMs;
          lastAttempt = {
            startedAtMs,
            endedAtMs: now,
            txid: acked,
            snapshotTxid: snapshotReadAt(snapshotTxid, acked),
          };
          if (tick.recorded) {
            const read = snapshotReadAt(snapshotTxid, acked);
            last = {
              lineageFence: fence,
              txid: acked,
              checkedAt: new Date(now).toISOString(),
              ok: true,
              ...(read !== undefined ? { snapshotTxid: read } : {}),
            };
          }
        }
        assert(checks <= 1, `${checks} checks`);
      },
    ),
  );
});

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
        idle: false,
        backstopMs: REPLICA_VERIFY_BACKSTOP_MS,
        retryMs: REPLICA_VERIFY_RETRY_MS,
      })
    ) {
      restores++;
      lastAttempt = {
        startedAtMs: now,
        endedAtMs: now,
        txid: acked,
        snapshotTxid: snapshot,
      };
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
  assertEquals(simulate(24, 5, [12]) <= 1 + 1 + 6, true);
  assertEquals(simulate(24, 24 * 60, []) <= 1 + 6, true);
});

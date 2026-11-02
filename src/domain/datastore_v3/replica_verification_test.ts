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
  isLineageBroken,
  parseReplicaVerification,
  type ReplicaVerification,
  type ReplicaVerifyObservation,
  shouldVerifyReplica,
} from "./replica_verification.ts";

const BACKSTOP = 4 * 60 * 60 * 1000;
/** 2026-10-25T12:00:00.000Z, the default verdict's checkedAt. */
const CHECKED_AT_MS = Date.parse("2026-10-25T12:00:00.000Z");

function observe(
  overrides: Partial<ReplicaVerifyObservation> = {},
): ReplicaVerifyObservation {
  return {
    lineageFence: 7,
    acknowledgedTxid: "0000000000000010",
    last: undefined,
    snapshotTxid: "0000000000000001",
    lastAttempt: undefined,
    nowMs: CHECKED_AT_MS + 60_000,
    backstopMs: BACKSTOP,
    ...overrides,
  };
}

function verdict(
  overrides: Partial<ReplicaVerification> = {},
): ReplicaVerification {
  return {
    lineageFence: 7,
    txid: "0000000000000010",
    checkedAt: "2026-10-25T12:00:00.000Z",
    ok: true,
    snapshotTxid: "0000000000000001",
    ...overrides,
  };
}

/** The writer has acknowledged past the default verdict. */
const moved = { last: verdict(), acknowledgedTxid: "0000000000000011" };

Deno.test("shouldVerifyReplica: checks a new lineage", () => {
  assertEquals(shouldVerifyReplica(observe()), true);
  // Even when the replica's snapshot is not known.
  assertEquals(shouldVerifyReplica(observe({ snapshotTxid: undefined })), true);
});

Deno.test("shouldVerifyReplica: nothing acknowledged, nothing to check", () => {
  assertEquals(
    shouldVerifyReplica(observe({ acknowledgedTxid: undefined })),
    false,
  );
  assertEquals(
    shouldVerifyReplica(observe({ acknowledgedTxid: "not-a-txid" })),
    false,
  );
});

Deno.test("shouldVerifyReplica: a verdict on the acknowledged TXID covers it", () => {
  assertEquals(
    shouldVerifyReplica(
      observe({
        last: verdict(),
        acknowledgedTxid: "10",
        snapshotTxid: "99",
        nowMs: CHECKED_AT_MS + 10 * BACKSTOP,
      }),
    ),
    false,
  );
  // A failed verdict covers it too: the restart, not another check, is next.
  assertEquals(
    shouldVerifyReplica(observe({ last: verdict({ ok: false }) })),
    false,
  );
});

Deno.test("shouldVerifyReplica: a verdict on another lineage covers nothing", () => {
  assertEquals(
    shouldVerifyReplica(observe({ last: verdict({ lineageFence: 6 }) })),
    true,
  );
});

Deno.test("shouldVerifyReplica: new acknowledgements alone wait for the backstop", () => {
  assertEquals(
    shouldVerifyReplica(
      observe({ ...moved, nowMs: CHECKED_AT_MS + BACKSTOP - 1 }),
    ),
    false,
  );
  assertEquals(
    shouldVerifyReplica(observe({ ...moved, nowMs: CHECKED_AT_MS + BACKSTOP })),
    true,
  );
});

Deno.test("shouldVerifyReplica: the backstop counts from the recorded verdict, not the sidecar's start", () => {
  // A fresh sidecar (no attempt of its own) shortly after another's check.
  assertEquals(
    shouldVerifyReplica(
      observe({ ...moved, lastAttempt: undefined, nowMs: CHECKED_AT_MS + 1 }),
    ),
    false,
  );
  // A verdict dated after now (a clock moved back) never starts a loop.
  assertEquals(
    shouldVerifyReplica(observe({ ...moved, nowMs: CHECKED_AT_MS - 1 })),
    false,
  );
});

Deno.test("shouldVerifyReplica: a new snapshot is checked before the backstop", () => {
  assertEquals(
    shouldVerifyReplica(
      observe({ ...moved, snapshotTxid: "0000000000000011" }),
    ),
    true,
  );
  // Spelled differently, the same snapshot is not new.
  assertEquals(
    shouldVerifyReplica(observe({ ...moved, snapshotTxid: "1" })),
    false,
  );
});

Deno.test("shouldVerifyReplica: an unknown snapshot is never a new one", () => {
  assertEquals(
    shouldVerifyReplica(observe({ ...moved, snapshotTxid: undefined })),
    false,
  );
});

Deno.test("shouldVerifyReplica: a verdict from before snapshots were recorded is checked once", () => {
  const old = verdict({ snapshotTxid: undefined });
  assertEquals(
    shouldVerifyReplica(
      observe({ last: old, acknowledgedTxid: "0000000000000011" }),
    ),
    true,
  );
  assertEquals(
    shouldVerifyReplica(
      observe({
        last: old,
        acknowledgedTxid: "0000000000000011",
        snapshotTxid: undefined,
      }),
    ),
    false,
  );
});

Deno.test("shouldVerifyReplica: a sidecar does not retry its own check before the backstop or a new snapshot", () => {
  // Its check of a new lineage ended without a verdict.
  const attempt = {
    startedAtMs: CHECKED_AT_MS,
    snapshotTxid: "0000000000000001",
  };
  assertEquals(
    shouldVerifyReplica(
      observe({ lastAttempt: attempt, nowMs: CHECKED_AT_MS + BACKSTOP - 1 }),
    ),
    false,
  );
  assertEquals(
    shouldVerifyReplica(
      observe({
        lastAttempt: attempt,
        nowMs: CHECKED_AT_MS + 1,
        snapshotTxid: "0000000000000002",
      }),
    ),
    true,
  );
  assertEquals(
    shouldVerifyReplica(
      observe({ lastAttempt: attempt, nowMs: CHECKED_AT_MS + BACKSTOP }),
    ),
    true,
  );
});

Deno.test("isLineageBroken: only a failed verdict on that lineage", () => {
  assertEquals(isLineageBroken(verdict({ ok: false }), 7), true);
  assertEquals(isLineageBroken(verdict({ ok: false }), 8), false);
  assertEquals(isLineageBroken(verdict(), 7), false);
  assertEquals(isLineageBroken(undefined, 7), false);
});

Deno.test("parseReplicaVerification: reads a recorded verdict", () => {
  assertEquals(
    parseReplicaVerification({
      lineageFence: 7,
      txid: "1A",
      checkedAt: "2026-10-25T12:00:00.000Z",
      ok: false,
      error: "integrity check failed",
    }),
    {
      lineageFence: 7,
      txid: "000000000000001a",
      checkedAt: "2026-10-25T12:00:00.000Z",
      ok: false,
      error: "integrity check failed",
    },
  );
  assertEquals(
    parseReplicaVerification({
      lineageFence: 7,
      txid: "10",
      checkedAt: "2026-10-25T12:00:00.000Z",
      ok: true,
      snapshotTxid: "1",
    }),
    verdict(),
  );
});

Deno.test("parseReplicaVerification: anything else reads as no verdict", () => {
  const good = {
    lineageFence: 7,
    txid: "10",
    checkedAt: "2026-10-25T12:00:00.000Z",
    ok: true,
  };
  for (
    const bad of [
      null,
      "broken",
      [],
      { ...good, lineageFence: 0 },
      { ...good, lineageFence: 1.5 },
      { ...good, lineageFence: "7" },
      { ...good, txid: "xyz" },
      { ...good, checkedAt: "yesterday" },
      { ...good, ok: "false" },
      { ...good, error: 3 },
      { ...good, snapshotTxid: "xyz" },
      { ...good, snapshotTxid: 1.5 },
    ]
  ) {
    assertEquals(parseReplicaVerification(bad), undefined);
  }
});

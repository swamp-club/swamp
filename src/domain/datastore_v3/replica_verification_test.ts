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

const INTERVAL = 600_000;

function observe(
  overrides: Partial<ReplicaVerifyObservation> = {},
): ReplicaVerifyObservation {
  return {
    lineageFence: 7,
    acknowledgedTxid: "0000000000000010",
    last: undefined,
    lastStartedAtMs: undefined,
    lastAttemptedTxid: undefined,
    nowMs: 1_000_000,
    idle: false,
    intervalMs: INTERVAL,
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
    ...overrides,
  };
}

Deno.test("shouldVerifyReplica: checks a lineage it never checked", () => {
  assertEquals(shouldVerifyReplica(observe()), true);
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
      observe({ last: verdict(), acknowledgedTxid: "10", idle: true }),
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

Deno.test("shouldVerifyReplica: waits out the interval after its last check", () => {
  const moved = { last: verdict(), acknowledgedTxid: "0000000000000011" };
  assertEquals(
    shouldVerifyReplica(
      observe({ ...moved, lastStartedAtMs: 1_000_000 - INTERVAL + 1 }),
    ),
    false,
  );
  assertEquals(
    shouldVerifyReplica(
      observe({ ...moved, lastStartedAtMs: 1_000_000 - INTERVAL }),
    ),
    true,
  );
});

Deno.test("shouldVerifyReplica: a sidecar about to idle out checks what it replicated", () => {
  assertEquals(
    shouldVerifyReplica(
      observe({
        last: verdict(),
        acknowledgedTxid: "0000000000000011",
        lastStartedAtMs: 1_000_000 - 1,
        idle: true,
      }),
    ),
    true,
  );
});

Deno.test("shouldVerifyReplica: an idle sidecar tries a TXID once, then may exit", () => {
  const unreached = {
    lastStartedAtMs: 1_000_000 - 1,
    lastAttemptedTxid: "0000000000000010",
  };
  assertEquals(
    shouldVerifyReplica(observe({ ...unreached, idle: true })),
    false,
  );
  // Running on, it tries again once the interval has passed.
  assertEquals(
    shouldVerifyReplica(
      observe({ ...unreached, lastStartedAtMs: 1_000_000 - INTERVAL }),
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
    verdict({
      txid: "000000000000001a",
      ok: false,
      error: "integrity check failed",
    }),
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
    ]
  ) {
    assertEquals(parseReplicaVerification(bad), undefined);
  }
});

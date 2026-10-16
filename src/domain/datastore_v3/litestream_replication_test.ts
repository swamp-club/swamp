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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideSidecarAction,
  isReplicated,
  type PresenceObservation,
  shouldIdleExit,
  SIDECAR_IDLE_TIMEOUT_MS,
  type SidecarObservation,
  V3_REPLICATION_UNCONFIRMED_CODE,
  V3ReplicationError,
  V3ReplicationUnavailableError,
} from "./litestream_replication.ts";

Deno.test("isReplicated: synced or no_change with the replica caught up confirms", () => {
  assert(isReplicated({ status: "synced", txid: 5, replicated_txid: 5 }));
  assert(isReplicated({ status: "no_change", txid: 5, replicated_txid: 6 }));
  assert(
    isReplicated({
      status: "synced",
      txid: "000000000000000a",
      replicated_txid: "000000000000000a",
    }),
  );
});

Deno.test("isReplicated: anything else confirms nothing", () => {
  assertEquals(
    isReplicated({ status: "synced", txid: 6, replicated_txid: 5 }),
    false,
  );
  assertEquals(
    isReplicated({ status: "error", txid: 5, replicated_txid: 5 }),
    false,
  );
  assertEquals(isReplicated({ status: "synced", txid: 5 }), false);
  assertEquals(isReplicated({ status: "synced", replicated_txid: 5 }), false);
  assertEquals(
    isReplicated({ status: "synced", txid: -1, replicated_txid: 5 }),
    false,
  );
  assertEquals(
    isReplicated({ status: "synced", txid: "zz", replicated_txid: 5 }),
    false,
  );
});

Deno.test("shouldIdleExit: only once the whole timeout has passed", () => {
  assertEquals(
    shouldIdleExit(1_000, 1_000 + SIDECAR_IDLE_TIMEOUT_MS - 1),
    false,
  );
  assertEquals(shouldIdleExit(1_000, 1_000 + SIDECAR_IDLE_TIMEOUT_MS), true);
  assertEquals(shouldIdleExit(0, 50, 50), true);
});

Deno.test("V3ReplicationError: carries its code and says the commits are kept", () => {
  const error = new V3ReplicationError("the sync timed out after 60s");
  assertEquals(error.code, V3_REPLICATION_UNCONFIRMED_CODE);
  assertStringIncludes(error.message, "the sync timed out after 60s");
  assertStringIncludes(error.message, "kept in commits.db");
});

Deno.test("V3ReplicationError: says another checkout's write first loses the commits (swamp-club#3565)", () => {
  const error = new V3ReplicationError("the sync timed out after 60s");
  assertStringIncludes(error.message, "in this checkout");
  assertStringIncludes(
    error.message,
    "if another checkout writes to the datastore first, they are lost",
  );
});

const OURS: PresenceObservation = {
  kind: "found",
  otherOwner: false,
  supervisorVerified: true,
  supervisorPid: 100,
  litestreamPid: 101,
  litestreamVerified: true,
  lineageFence: 3,
};

function observe(over: Partial<SidecarObservation> = {}): SidecarObservation {
  return {
    supervisorLock: "held",
    presence: OURS,
    answered: true,
    lineageFence: 3,
    marked: false,
    waitedPastDeadline: false,
    ...over,
  };
}

Deno.test("decideSidecarAction: reuses this user's live sidecar on this lineage", () => {
  assertEquals(decideSidecarAction(observe()), { kind: "reuse" });
});

Deno.test("decideSidecarAction: a free lock starts one, killing a verified orphan first", () => {
  assertEquals(
    decideSidecarAction(observe({ supervisorLock: "free" })),
    { kind: "start", orphanPid: 101 },
  );
  assertEquals(
    decideSidecarAction(
      observe({
        supervisorLock: "free",
        presence: { ...OURS, litestreamVerified: false },
      }),
    ),
    { kind: "start" },
  );
  assertEquals(
    decideSidecarAction(
      observe({ supervisorLock: "free", presence: { kind: "missing" } }),
    ),
    { kind: "start" },
  );
});

Deno.test("decideSidecarAction: a stale record naming an unrelated live pid is never killed", () => {
  // The lock is held, but the recorded pid is not this database's supervisor.
  const stale = observe({
    presence: { ...OURS, supervisorVerified: false },
    answered: false,
  });
  assertEquals(decideSidecarAction(stale), { kind: "wait" });
  assertEquals(
    decideSidecarAction({ ...stale, waitedPastDeadline: true }).kind,
    "refuse",
  );
});

Deno.test("decideSidecarAction: a lock held without a readable record waits, then refuses", () => {
  const starting = observe({ presence: { kind: "missing" }, answered: false });
  assertEquals(decideSidecarAction(starting), { kind: "wait" });
  assertEquals(
    decideSidecarAction({ ...starting, waitedPastDeadline: true }).kind,
    "refuse",
  );
});

Deno.test("decideSidecarAction: another user's or host's sidecar is refused, never touched", () => {
  assertEquals(
    decideSidecarAction(observe({ presence: { kind: "foreign" } })).kind,
    "refuse",
  );
  assertEquals(
    decideSidecarAction(observe({ presence: { ...OURS, otherOwner: true } }))
      .kind,
    "refuse",
  );
});

Deno.test("decideSidecarAction: a sidecar that does not answer is waited for, then replaced as frozen", () => {
  assertEquals(decideSidecarAction(observe({ answered: false })), {
    kind: "wait",
  });
  assertEquals(
    decideSidecarAction(observe({ answered: false, waitedPastDeadline: true })),
    {
      kind: "replace",
      reason: "frozen",
      supervisorPid: 100,
      litestreamPid: 101,
    },
  );
});

Deno.test("decideSidecarAction: another lineage or a replacement mark replaces it", () => {
  assertEquals(decideSidecarAction(observe({ lineageFence: 9 })), {
    kind: "replace",
    reason: "lineage",
    supervisorPid: 100,
    litestreamPid: 101,
  });
  assertEquals(decideSidecarAction(observe({ marked: true })), {
    kind: "replace",
    reason: "marked",
    supervisorPid: 100,
    litestreamPid: 101,
  });
});

Deno.test("decideSidecarAction: an unverified Litestream pid is left out of a replacement", () => {
  assertEquals(
    decideSidecarAction(
      observe({
        marked: true,
        presence: { ...OURS, litestreamVerified: false },
      }),
    ),
    { kind: "replace", reason: "marked", supervisorPid: 100 },
  );
});

Deno.test('V3ReplicationUnavailableError: its reason embeds without a second "Nothing was changed" (swamp-club#3497)', () => {
  const error = new V3ReplicationUnavailableError("the sidecar is busy");
  assertEquals(
    error.reason,
    "swamp cannot replicate this v3 datastore: the sidecar is busy",
  );
  assertEquals(error.message, `${error.reason}. Nothing was changed.`);
});

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
import { RUN_INITIATOR_MISMATCH_CODE } from "./commit_authorization.ts";
import { fixtureCommit, saveOps } from "./offline_rebase_test_helpers.ts";
import {
  isRetryableRejection,
  nextStepForRejected,
  rejectedWritesOf,
} from "./rejected_write.ts";

Deno.test("isRetryableRejection: a version refused as live or reused is retried, by its code or, from an older swamp, its reason", () => {
  for (const code of ["version-live", "version-reused"]) {
    assert(isRetryableRejection({ state: "rejected", stateCode: code }));
  }
  assert(isRetryableRejection({
    state: "rejected",
    stateReason:
      "Data result version 246 is already live; only an append re-records it",
  }));
  assert(isRetryableRejection({
    state: "rejected",
    stateReason:
      "Data result version 3 was removed; it is never recorded again",
  }));
  assertEquals(
    isRetryableRejection({ state: "rejected", stateCode: "expect-failed" }),
    false,
  );
  assertEquals(
    isRetryableRejection({
      state: "rejected",
      stateCode: "target-changed",
      stateReason: "Data x version 1 is already live; only an append",
    }),
    false,
  );
  assertEquals(
    isRetryableRejection({ state: "offline", stateCode: "version-live" }),
    false,
  );
  assertEquals(
    isRetryableRejection({ state: "quarantined", stateCode: "version-live" }),
    false,
  );
});

Deno.test("rejectedWritesOf: names each data version the commit records, with its behavior, txnId, reason and next step", async () => {
  const commit = fixtureCommit({
    seq: 3,
    txnId: "t-1",
    ops: [
      ...await saveOps({ name: "result", version: 7 }),
      ...await saveOps({ name: "log", version: 7 }),
    ],
  });
  const writes = rejectedWritesOf(commit, {
    reason: "Data result version 7 is already live; only an append",
    code: "version-live",
  });
  assertEquals(
    writes.map((write) => [write.name, write.version, write.txnId]),
    [["result", 7, "t-1"], ["log", 7, "t-1"]],
  );
  assert(writes.every((write) => write.retryable));
  assert(writes[0].next.includes("sends it again"));
  assert(writes[0].behavior.includes("/"));

  const puts = (await saveOps({ name: "result", version: 1 })).filter((op) =>
    op.kind !== "data-version"
  );
  const bare = rejectedWritesOf(
    fixtureCommit({ seq: 1, txnId: "t-2", ops: puts }),
    { reason: "refused" },
  );
  assertEquals(bare.length, 1);
  assertEquals([bare[0].name, bare[0].version], [undefined, undefined]);
  assertEquals(bare[0].retryable, false);
});

Deno.test("nextStepForRejected: a retried entry needs nothing done, a run record refused for its initiator says to upgrade, a conflict says to check the data", () => {
  assert(
    nextStepForRejected({ retryable: true }).startsWith("Nothing to do"),
  );
  assert(
    nextStepForRejected({
      retryable: false,
      code: RUN_INITIATOR_MISMATCH_CODE,
    }).includes("upgrade swamp"),
  );
  assert(
    nextStepForRejected({ retryable: false }).includes("check the data"),
  );
  for (const retryable of [true, false]) {
    assertEquals(
      nextStepForRejected({ retryable }).includes("swamp datastore"),
      false,
    );
  }
});

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

import { assertEquals, assertRejects } from "@std/assert";
import { ReplicationGroupCommit } from "./replication_group_commit.ts";
import { V3ReplicationError } from "./litestream_replication.ts";

/** A sync the test settles by hand, recording each call. */
function manualSyncs() {
  const calls: PromiseWithResolvers<number | undefined>[] = [];
  return {
    calls,
    sync: () => {
      const call = Promise.withResolvers<number | undefined>();
      calls.push(call);
      return call.promise;
    },
  };
}

/** Lets settled promises run their handlers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Tracks a promise's outcome without awaiting it. */
function outcome(promise: Promise<void>) {
  const state: { settled?: "resolved" | "rejected"; error?: unknown } = {};
  promise.then(
    () => state.settled = "resolved",
    (error) => {
      state.settled = "rejected";
      state.error = error;
    },
  );
  return state;
}

Deno.test("ReplicationGroupCommit: a lone caller is confirmed by one sync", async () => {
  const syncs = manualSyncs();
  const group = new ReplicationGroupCommit(syncs.sync);
  const confirmed = group.confirm(3);
  assertEquals(syncs.calls.length, 1);
  syncs.calls[0].resolve(3);
  await confirmed;
  assertEquals(syncs.calls.length, 1);
});

Deno.test("ReplicationGroupCommit: callers waiting together share one sync", async () => {
  const syncs = manualSyncs();
  const group = new ReplicationGroupCommit(syncs.sync);
  const first = group.confirm(1);
  // Arrive while the first sync runs: they wait for the next one.
  const rest = [2, 3, 4].map((mark) => group.confirm(mark));
  assertEquals(syncs.calls.length, 1);
  syncs.calls[0].resolve(1);
  await first;
  await flush();
  assertEquals(syncs.calls.length, 2);
  syncs.calls[1].resolve(4);
  await Promise.all(rest);
  assertEquals(syncs.calls.length, 2);
});

Deno.test("ReplicationGroupCommit: a sync in flight does not confirm a later commit its head misses", async () => {
  const syncs = manualSyncs();
  const group = new ReplicationGroupCommit(syncs.sync);
  const first = group.confirm(1);
  const later = outcome(group.confirm(2));
  syncs.calls[0].resolve(1);
  await first;
  await flush();
  assertEquals(later.settled, undefined);
  assertEquals(syncs.calls.length, 2);
  syncs.calls[1].resolve(2);
  await flush();
  assertEquals(later.settled, "resolved");
});

Deno.test("ReplicationGroupCommit: a caller arriving mid-sync is confirmed by a head that covers it", async () => {
  const syncs = manualSyncs();
  const group = new ReplicationGroupCommit(syncs.sync);
  const first = group.confirm(1);
  const later = group.confirm(2);
  // The sync read its mark after the second commit landed.
  syncs.calls[0].resolve(2);
  await Promise.all([first, later]);
  await flush();
  assertEquals(syncs.calls.length, 1);
});

Deno.test("ReplicationGroupCommit: a failed sync rejects only the callers it covered", async () => {
  const syncs = manualSyncs();
  const group = new ReplicationGroupCommit(syncs.sync);
  const first = outcome(group.confirm(1));
  const later = outcome(group.confirm(2));
  const failure = new V3ReplicationError("the sidecar did not answer");
  syncs.calls[0].reject(failure);
  await flush();
  assertEquals(first.settled, "rejected");
  assertEquals(first.error, failure);
  assertEquals(later.settled, undefined);
  assertEquals(syncs.calls.length, 2);
  syncs.calls[1].resolve(2);
  await flush();
  assertEquals(later.settled, "resolved");
});

Deno.test("ReplicationGroupCommit: a sync that published no head rejects as unconfirmed", async () => {
  const syncs = manualSyncs();
  const group = new ReplicationGroupCommit(syncs.sync);
  const confirmed = group.confirm(1);
  syncs.calls[0].resolve(undefined);
  await assertRejects(() => confirmed, V3ReplicationError, "published no head");
});

Deno.test("ReplicationGroupCommit: a head below a covered caller's mark rejects instead of syncing again", async () => {
  const syncs = manualSyncs();
  const group = new ReplicationGroupCommit(syncs.sync);
  const confirmed = group.confirm(5);
  syncs.calls[0].resolve(4);
  await assertRejects(() => confirmed, V3ReplicationError, "commit 5");
  await flush();
  assertEquals(syncs.calls.length, 1);
});

Deno.test("ReplicationGroupCommit: a sync that throws synchronously rejects its callers and the next caller syncs again", async () => {
  let calls = 0;
  const group = new ReplicationGroupCommit(() => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return Promise.resolve(1);
  });
  await assertRejects(() => group.confirm(1), Error, "boom");
  await group.confirm(1);
  assertEquals(calls, 2);
});

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
import {
  type GroupCommitClock,
  ReplicationGroupCommit,
} from "./replication_group_commit.ts";
import {
  HeadPublishRateLimitedError,
  V3ReplicationError,
} from "./litestream_replication.ts";

function manualSyncs() {
  const calls: PromiseWithResolvers<number | undefined>[] = [];
  const covering: number[] = [];
  return {
    calls,
    covering,
    sync: (count: number) => {
      covering.push(count);
      const call = Promise.withResolvers<number | undefined>();
      calls.push(call);
      return call.promise;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

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

Deno.test("ReplicationGroupCommit: each sync is told how many callers it covers, one when it starts idle", async () => {
  const syncs = manualSyncs();
  const group = new ReplicationGroupCommit(syncs.sync);
  const first = group.confirm(1);
  const rest = [2, 3].map((mark) => group.confirm(mark));
  syncs.calls[0].resolve(1);
  await first;
  await flush();
  syncs.calls[1].resolve(3);
  await Promise.all(rest);
  // one alone, then the two that queued behind it
  assertEquals(syncs.covering, [1, 2]);
});

/** a clock whose timers fire only when the test advances it */
function manualClock(): GroupCommitClock & {
  advance: (ms: number) => void;
  pending: () => number;
} {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    advance: (ms) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    pending: () => timers.size,
  };
}

Deno.test("ReplicationGroupCommit: a round failed by a rate-limited head keeps its callers for one more round, and a second such failure rejects them", async () => {
  const syncs = manualSyncs();
  const group = new ReplicationGroupCommit(syncs.sync);
  const caller = outcome(group.confirm(1));
  syncs.calls[0].reject(new HeadPublishRateLimitedError("rate limited"));
  await flush();
  assertEquals(caller.settled, undefined);
  assertEquals(syncs.calls.length, 2);
  syncs.calls[1].reject(new HeadPublishRateLimitedError("rate limited"));
  await flush();
  assertEquals(caller.settled, "rejected");

  const next = outcome(group.confirm(2));
  await flush();
  syncs.calls[2].reject(new HeadPublishRateLimitedError("rate limited"));
  await flush();
  syncs.calls[3].resolve(2);
  await flush();
  assertEquals(next.settled, "resolved");
});

Deno.test("ReplicationGroupCommit: any other failure, a head 429 followed by a failed lease check among them, rejects at once", async () => {
  const syncs = manualSyncs();
  const group = new ReplicationGroupCommit(syncs.sync);
  const caller = outcome(group.confirm(1));
  syncs.calls[0].reject(
    new V3ReplicationError("the writer lease could not be checked", {
      cause: new HeadPublishRateLimitedError("rate limited"),
    }),
  );
  await flush();
  assertEquals(caller.settled, "rejected");
  assertEquals(syncs.calls.length, 1);
});

Deno.test("ReplicationGroupCommit: a caller is rejected at its deadline while a round runs, a later round never settles it again, and no timer is left", async () => {
  const syncs = manualSyncs();
  const clock = manualClock();
  const group = new ReplicationGroupCommit(syncs.sync, clock);
  let settlements = 0;
  const promise = group.confirm(1, 10_000);
  promise.then(() => settlements++, () => settlements++);
  const caller = outcome(promise);
  const other = outcome(group.confirm(1));
  clock.advance(10_000);
  await flush();
  assertEquals(caller.settled, "rejected");
  assertEquals(other.settled, undefined);
  syncs.calls[0].resolve(1);
  await flush();
  assertEquals(other.settled, "resolved");
  assertEquals(settlements, 1);
  assertEquals(clock.pending(), 0);
});

Deno.test("ReplicationGroupCommit: a confirmed caller clears its deadline timer", async () => {
  const syncs = manualSyncs();
  const clock = manualClock();
  const group = new ReplicationGroupCommit(syncs.sync, clock);
  const caller = outcome(group.confirm(1, 10_000));
  syncs.calls[0].resolve(1);
  await flush();
  assertEquals(caller.settled, "resolved");
  assertEquals(clock.pending(), 0);
});

Deno.test("ReplicationGroupCommit: a caller whose deadline has passed is rejected without starting a sync", async () => {
  const syncs = manualSyncs();
  const clock = manualClock();
  clock.advance(5_000);
  const group = new ReplicationGroupCommit(syncs.sync, clock);
  const caller = outcome(group.confirm(1, 5_000));
  await flush();
  assertEquals(caller.settled, "rejected");
  assertEquals(syncs.calls.length, 0);
  assertEquals(clock.pending(), 0);
});

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
import { waitFor } from "@swamp-club/swamp-testing";
import { ModelType } from "../domain/models/model_type.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../domain/datastore_v3/partition_key.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import type { V3CommitFeedSource } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import type { FollowerGate } from "./follower_requests.ts";
import { wireFollowerPolicy } from "./follower_policy_wiring.ts";

await initializeLogging({});

const GRANT = partitionOf({
  kind: "model",
  type: ModelType.create("swamp/grant"),
  id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
});

/** A copy whose head the test moves; the source bound is its head. */
function fakeSource() {
  const rows: { cursor: number; partition: PartitionKey }[] = [];
  const listeners = new Set<(replaced: boolean) => void>();
  const source = {
    datastore: {
      commitStore: {
        highWaterMark: () => ({ cursor: rows.at(-1)?.cursor ?? 0 }),
        changesSince: (cursor: number, limit: number) =>
          Promise.resolve(
            rows.filter((row) => row.cursor > cursor).slice(0, limit).map((
              row,
            ) => ({
              cursor: row.cursor,
              commit: { partition: row.partition },
            })),
          ),
      },
    },
    bound: () => rows.at(-1)?.cursor ?? 0,
    onMoved: (listener: (replaced: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as V3CommitFeedSource;
  return {
    source,
    land(partition: PartitionKey) {
      rows.push({ cursor: (rows.at(-1)?.cursor ?? 0) + 1, partition });
      for (const listener of listeners) listener(false);
    },
    restored() {
      for (const listener of listeners) listener(true);
    },
  };
}

function leadership(role: "leader" | "follower", stale = false): FollowerGate {
  return { role, leader: () => undefined, isStale: () => stale };
}

function setup(role: { current: "leader" | "follower" }) {
  const store = fakeSource();
  let release: (() => void) | undefined;
  let hold = false;
  const wiring = wireFollowerPolicy({
    source: store.source,
    catchUpReadModel: () =>
      hold ? new Promise<void>((done) => release = done) : Promise.resolve(),
    catalogInvalidate: () => {},
    reloadPolicy: () => Promise.resolve(),
    checkConfig: () => {},
    isFollower: () => role.current === "follower",
  });
  wiring.effects.start();
  return {
    store,
    wiring,
    holdCatchUp() {
      hold = true;
    },
    release() {
      hold = false;
      release?.();
    },
    released: () => release !== undefined,
  };
}

Deno.test("wireFollowerPolicy: a follower's feed ends at the last commit whose effects were applied, and moves when they are", async () => {
  const t = setup({ current: "follower" });
  const moved: number[] = [];
  const off = t.wiring.commitFeed.onMoved(() =>
    moved.push(t.wiring.commitFeed.bound())
  );
  try {
    t.holdCatchUp();
    t.store.land(GRANT);
    await waitFor(t.released, "the catch-up started");
    assertEquals(t.wiring.commitFeed.bound(), 0);
    t.release();
    await t.wiring.effects.settled();
    assertEquals(t.wiring.commitFeed.bound(), 1);
    assertEquals(moved.at(-1), 1);
  } finally {
    off();
    await t.wiring.effects.stop();
  }
});

Deno.test("wireFollowerPolicy: the leader's feed is bounded only by its source", async () => {
  const t = setup({ current: "leader" });
  try {
    t.holdCatchUp();
    t.store.land(GRANT);
    assertEquals(t.wiring.commitFeed.bound(), 1);
  } finally {
    await t.wiring.effects.stop();
  }
});

Deno.test("wireFollowerPolicy: a follower keeps answering reads through a replaced copy, bounded at what its policy covers (swamp-club#4207)", async () => {
  const t = setup({ current: "follower" });
  try {
    const follower = t.wiring.gate(leadership("follower"));
    t.store.land(GRANT);
    await t.wiring.effects.settled();
    // A failover: the feed stops and the tick restores the copy.
    t.store.restored();
    t.store.land(GRANT);
    await t.wiring.effects.settled();
    assertEquals(follower.isStale(), false);
    assertEquals(t.wiring.commitFeed.bound(), 1);
    t.wiring.effects.poke();
    await t.wiring.effects.settled();
    assertEquals(t.wiring.commitFeed.bound(), 2);
  } finally {
    await t.wiring.effects.stop();
  }
});

Deno.test("wireFollowerPolicy: a follower whose reload failed reads as stale until one succeeds; a leader never does", async () => {
  let fail = true;
  const store = fakeSource();
  const wiring = wireFollowerPolicy({
    source: store.source,
    catchUpReadModel: () => Promise.resolve(),
    catalogInvalidate: () => {},
    reloadPolicy: () =>
      fail ? Promise.reject(new Error("unreadable")) : Promise.resolve(),
    checkConfig: () => {},
    isFollower: () => true,
  });
  wiring.effects.start();
  try {
    const follower = wiring.gate(leadership("follower"));
    const leader = wiring.gate(leadership("leader"));
    assertEquals(follower.isStale(), false);
    store.land(GRANT);
    await wiring.effects.settled();
    assertEquals(follower.isStale(), true);
    assertEquals(leader.isStale(), false);
    assertEquals(follower.role, "follower");
    fail = false;
    wiring.effects.poke();
    await wiring.effects.settled();
    assertEquals(follower.isStale(), false);
    // A stale copy still reads as stale.
    assertEquals(wiring.gate(leadership("follower", true)).isStale(), true);
  } finally {
    await wiring.effects.stop();
  }
});

Deno.test("wireFollowerPolicy: a forwarded write's barrier waits for the effects of what the feed brought in", async () => {
  const t = setup({ current: "follower" });
  try {
    t.holdCatchUp();
    let barrierDone = false;
    const barrier = t.wiring.barrier(() => {
      t.store.land(GRANT);
      return Promise.resolve();
    })().then(() => barrierDone = true);
    await waitFor(t.released, "the catch-up started");
    assertEquals(barrierDone, false);
    t.release();
    await barrier;
    assertEquals(t.wiring.commitFeed.bound(), 1);
  } finally {
    await t.wiring.effects.stop();
  }
});

Deno.test("wireFollowerPolicy: a forwarded write's barrier returns once its commits are applied, though more keep landing", async () => {
  const t = setup({ current: "follower" });
  try {
    const barrier = t.wiring.barrier(() => {
      t.store.land(GRANT);
      return Promise.resolve();
    })();
    // A busy feed: a pass is always queued behind the one running.
    let landing = true;
    const busy = (async () => {
      while (landing) {
        t.store.land(GRANT);
        await new Promise((tick) => queueMicrotask(() => tick(undefined)));
      }
    })();
    await barrier;
    landing = false;
    await busy;
    assertEquals(t.wiring.commitFeed.bound() >= 1, true);
  } finally {
    await t.wiring.effects.stop();
  }
});

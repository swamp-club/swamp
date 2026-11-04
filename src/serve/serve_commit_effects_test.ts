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
import { partitionOf } from "../domain/datastore_v3/partition_key.ts";
import type { PartitionKey } from "../domain/datastore_v3/partition_key.ts";
import { CommitsCompactedError } from "../domain/datastore_v3/commit_store.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import {
  ServeCommitEffects,
  type ServeCommitEffectsDeps,
} from "./serve_commit_effects.ts";

await initializeLogging({});

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const GRANT = partitionOf({
  kind: "model",
  type: ModelType.create("swamp/grant"),
  id: ID,
});

function fakeSource() {
  const rows: { cursor: number; partition: PartitionKey }[] = [];
  let compactedTo = 0;
  let unappliedFrom: number | undefined;
  const listeners = new Set<(replaced: boolean) => void>();
  const source = {
    datastore: {
      readModel: {
        cursor: () => unappliedFrom ?? rows.at(-1)?.cursor ?? compactedTo,
      },
      commitStore: {
        highWaterMark: () => ({ cursor: rows.at(-1)?.cursor ?? compactedTo }),
        changesSince: (cursor: number, limit: number) => {
          if (cursor < compactedTo) {
            return Promise.reject(new CommitsCompactedError(compactedTo, "x"));
          }
          return Promise.resolve(
            rows.filter((row) => row.cursor > cursor).slice(0, limit).map((
              row,
            ) => ({
              cursor: row.cursor,
              commit: { partition: row.partition },
            })),
          );
        },
      },
    },
    onMoved: (listener: (replaced: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ServeCommitEffectsDeps["source"];
  return {
    source,
    land(partition: PartitionKey) {
      this.landQuietly(partition);
      for (const listener of listeners) listener(false);
    },
    landUnapplied(partition: PartitionKey) {
      unappliedFrom ??= rows.at(-1)?.cursor ?? compactedTo;
      this.land(partition);
    },
    applied() {
      unappliedFrom = undefined;
    },
    restored() {
      for (const listener of listeners) listener(true);
    },
    landQuietly(partition: PartitionKey) {
      rows.push({
        cursor: (rows.at(-1)?.cursor ?? compactedTo) + 1,
        partition,
      });
    },
    replace(cursor: number) {
      rows.length = 0;
      compactedTo = cursor;
      for (const listener of listeners) listener(true);
    },
  };
}

function setup(follower = true, slowPolicy = false) {
  const store = fakeSource();
  const calls = { policy: 0, config: 0 };
  const gate = Promise.withResolvers<void>();
  const effects = new ServeCommitEffects({
    source: store.source,
    reloadPolicy: () => {
      calls.policy++;
      return slowPolicy ? gate.promise : Promise.resolve();
    },
    checkConfig: () => calls.config++,
    isFollower: () => follower,
  });
  const passes = { applied: 0 };
  effects.onApplied(() => passes.applied++);
  effects.start();
  return { store, calls, passes, effects, release: () => gate.resolve() };
}

Deno.test("ServeCommitEffects: a grant commit reloads the policy", async () => {
  const { store, calls, effects } = setup();
  try {
    store.land(
      partitionOf({
        kind: "model",
        type: ModelType.create("swamp/grant"),
        id: ID,
      }),
    );
    effects.poke();
    await waitFor(() => calls.policy === 1, "calls.policy === 1");
    await effects.settled();
    assertEquals(calls, { policy: 1, config: 0 });
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a lockfile or definition commit runs the config check; runtime data leaves the catalog to the read model", async () => {
  const { store, calls, passes, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    effects.poke();
    await waitFor(() => passes.applied === 1, "the pass applied");
    await effects.settled();
    assertEquals(calls, { policy: 0, config: 0 });
    store.land(partitionOf({ kind: "lockfile" }));
    effects.poke();
    await waitFor(() => calls.config === 1, "calls.config === 1");
    store.land(
      partitionOf({ kind: "config", definitionKind: "model", name: "web" }),
    );
    effects.poke();
    await waitFor(() => calls.config === 2, "calls.config === 2");
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a copy replaced behind what was read reloads the policy and runs the config check", async () => {
  const { store, calls, passes, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    effects.poke();
    await waitFor(() => passes.applied >= 1, "the pass applied");
    await effects.settled();
    store.replace(0);
    effects.poke();
    await waitFor(
      () => calls.policy === 1 && calls.config === 1,
      "calls.policy === 1 && calls.config === 1",
    );
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: stops watching once stopped", async () => {
  const { store, calls, effects } = setup();
  await effects.stop();
  store.land(partitionOf({ kind: "lockfile" }));
  await effects.settled();
  assertEquals(calls, { policy: 0, config: 0 });
});

Deno.test("ServeCommitEffects: on the leader only the config check runs; its own writes keep its catalog and policy current", async () => {
  const { store, calls, effects } = setup(false);
  try {
    store.land(
      partitionOf({
        kind: "model",
        type: ModelType.create("swamp/grant"),
        id: ID,
      }),
    );
    store.land(partitionOf({ kind: "lockfile" }));
    await waitFor(() => calls.config === 1, "the config check");
    await effects.settled();
    assertEquals(calls, { policy: 0, config: 1 });
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects.poke: finds commits another process landed in a shared copy", async () => {
  const { store, calls, effects } = setup();
  try {
    store.landQuietly(partitionOf({ kind: "lockfile" }));
    await effects.settled();
    assertEquals(calls.config, 0);
    effects.poke();
    await waitFor(() => calls.config === 1, "the config check");
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a replaced copy refreshes everything, even with its head at or past what was read", async () => {
  const { store, calls, passes, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    effects.poke();
    await waitFor(() => passes.applied === 1, "the first pass");
    await effects.settled();
    store.restored();
    effects.poke();
    await waitFor(
      () => calls.policy === 1 && calls.config === 1,
      "a full refresh",
    );
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a follower reloads only once its copy is caught up, so a restore reads the restored grants", async () => {
  const { store, calls, effects } = setup();
  try {
    store.restored();
    store.landUnapplied(GRANT);
    await effects.settled();
    assertEquals(calls, { policy: 0, config: 0 });
    store.applied();
    effects.poke();
    await waitFor(() => calls.policy === 1, "the policy reloaded");
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a poke leaves a commit its read model has not applied for the poke after it", async () => {
  const { store, calls, passes, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    store.landUnapplied(GRANT);
    effects.poke();
    await waitFor(() => passes.applied === 1, "the first pass");
    await effects.settled();
    assertEquals(calls.policy, 0);
    store.applied();
    effects.poke();
    await waitFor(() => calls.policy === 1, "the policy reloaded");
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a pass queued before a restore does not spend the restore's refresh", async () => {
  const { store, calls, effects, release } = setup(true, true);
  try {
    store.land(GRANT);
    effects.poke();
    await waitFor(() => calls.policy === 1, "the first reload started");
    effects.poke();
    store.restored();
    release();
    await effects.settled();
    assertEquals(calls.policy, 1);
    effects.poke();
    await waitFor(() => calls.policy === 2, "the restore's refresh");
  } finally {
    release();
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a follower taking the lead applies what its takeover restored before it leads", async () => {
  let follower = true;
  const store = fakeSource();
  const calls = { policy: 0, config: 0 };
  const effects = new ServeCommitEffects({
    source: store.source,
    reloadPolicy: () => {
      calls.policy++;
      return Promise.resolve();
    },
    checkConfig: () => calls.config++,
    isFollower: () => follower,
  });
  effects.start();
  try {
    store.land(GRANT);
    effects.poke();
    await effects.settled();
    assertEquals(calls, { policy: 1, config: 0 });
    follower = false;
    store.land(GRANT);
    await effects.settled();
    assertEquals(calls, { policy: 1, config: 0 });
  } finally {
    await effects.stop();
  }
});

function failingSetup(
  fail: () => boolean,
  follower: () => boolean = () => true,
) {
  const store = fakeSource();
  let reloads = 0;
  const effects = new ServeCommitEffects({
    source: store.source,
    reloadPolicy: () => {
      reloads++;
      return fail()
        ? Promise.reject(new Error("unreadable"))
        : Promise.resolve();
    },
    checkConfig: () => {},
    isFollower: follower,
  });
  effects.start();
  return { store, effects, reloads: () => reloads };
}

Deno.test("ServeCommitEffects: a follower's applied cursor moves only once its read model applied a commit and its effects ran (swamp-club#4207)", async () => {
  const { store, effects } = setup();
  const moves: number[] = [];
  const off = effects.onApplied(() => moves.push(effects.appliedCursor()));
  try {
    store.landUnapplied(GRANT);
    effects.poke();
    await effects.settled();
    assertEquals(effects.appliedCursor(), 0);
    store.applied();
    effects.poke();
    await effects.settled();
    assertEquals(effects.appliedCursor(), 1);
    assertEquals(moves, [1]);
  } finally {
    off();
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a reload that fails leaves a follower's policy unknown and its cursor in place, and the next poke retries it (swamp-club#4207)", async () => {
  let fail = true;
  const { store, effects, reloads } = failingSetup(() => fail);
  try {
    store.land(GRANT);
    effects.poke();
    await effects.settled();
    assertEquals(reloads(), 1);
    assertEquals(effects.policyKnown(), false);
    assertEquals(effects.appliedCursor(), 0);
    fail = false;
    effects.poke();
    await effects.settled();
    assertEquals(reloads(), 2);
    assertEquals(effects.policyKnown(), true);
    assertEquals(effects.appliedCursor(), 1);
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a node that takes the lead while its policy is unknown reloads it (swamp-club#4207)", async () => {
  let fail = true;
  let follower = true;
  const { store, effects, reloads } = failingSetup(() => fail, () => follower);
  try {
    store.land(GRANT);
    effects.poke();
    await effects.settled();
    assertEquals(effects.policyKnown(), false);
    fail = false;
    follower = false;
    store.land(partitionOf({ kind: "lockfile" }));
    await waitFor(() => effects.policyKnown(), "the policy reloaded");
    assertEquals(reloads(), 2);
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a copy replaced below what was applied moves the applied cursor down to its head (swamp-club#4207)", async () => {
  const { store, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    effects.poke();
    await waitFor(() => effects.appliedCursor() === 2, "applied to 2");
    await effects.settled();
    store.replace(1);
    effects.poke();
    await effects.settled();
    assertEquals(effects.appliedCursor(), 1);
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects.stop: a pass in flight ends without reloading the policy (swamp-club#4327)", async () => {
  const { store, calls, effects } = setup();
  const commitStore = store.source.datastore.commitStore as unknown as {
    changesSince: (cursor: number, limit: number) => Promise<unknown>;
  };
  const read = commitStore.changesSince;
  const reading = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  commitStore.changesSince = async (cursor, limit) => {
    reading.resolve();
    await gate.promise;
    return await read(cursor, limit);
  };
  store.land(GRANT);
  effects.poke();
  await reading.promise;
  const stopping = effects.stop();
  gate.resolve();
  await stopping;
  await effects.settled();
  assertEquals(calls, { policy: 0, config: 0 });
});

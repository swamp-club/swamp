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

/** A store of commits by partition, whose head the test moves. */
function fakeSource() {
  const rows: { cursor: number; partition: PartitionKey }[] = [];
  let compactedTo = 0;
  const listeners = new Set<(replaced: boolean) => void>();
  const source = {
    datastore: {
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
    /** A restore that replaced the copy, head at or above what was read. */
    restored() {
      for (const listener of listeners) listener(true);
    },
    /** As another process lands a commit: no head moves here. */
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

function setup(
  follower = true,
  options: {
    readonly catchUpReadModel?: () => Promise<void>;
    readonly reloadPolicy?: () => Promise<void>;
  } = {},
) {
  const store = fakeSource();
  const calls = { catalog: 0, policy: 0, config: 0 };
  const effects = new ServeCommitEffects({
    source: store.source,
    catchUpReadModel: options.catchUpReadModel ?? (() => Promise.resolve()),
    catalogInvalidate: () => calls.catalog++,
    reloadPolicy: () => {
      calls.policy++;
      return options.reloadPolicy?.() ?? Promise.resolve();
    },
    checkConfig: () => calls.config++,
    isFollower: () => follower,
  });
  effects.start();
  return { store, calls, effects };
}

const GRANT = partitionOf({
  kind: "model",
  type: ModelType.create("swamp/grant"),
  id: ID,
});

Deno.test("ServeCommitEffects: a grant commit reloads the policy and the catalog", async () => {
  const { store, calls, effects } = setup();
  try {
    store.land(
      partitionOf({
        kind: "model",
        type: ModelType.create("swamp/grant"),
        id: ID,
      }),
    );
    await waitFor(() => calls.policy === 1, "calls.policy === 1");
    await effects.settled();
    assertEquals(calls, { catalog: 1, policy: 1, config: 0 });
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a lockfile or definition commit runs the config check; runtime data only rebuilds the catalog", async () => {
  const { store, calls, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    await waitFor(() => calls.catalog === 1, "calls.catalog === 1");
    await effects.settled();
    assertEquals(calls, { catalog: 1, policy: 0, config: 0 });
    store.land(partitionOf({ kind: "lockfile" }));
    await waitFor(() => calls.config === 1, "calls.config === 1");
    store.land(
      partitionOf({ kind: "config", definitionKind: "model", name: "web" }),
    );
    await waitFor(() => calls.config === 2, "calls.config === 2");
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a copy replaced behind what was read refreshes everything", async () => {
  const { store, calls, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    await waitFor(() => calls.catalog >= 1, "calls.catalog >= 1");
    await effects.settled();
    store.replace(0);
    // The refresh that replaced the copy pokes once its read model is
    // rebuilt (swamp-club#4207).
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
  assertEquals(calls, { catalog: 0, policy: 0, config: 0 });
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
    assertEquals(calls, { catalog: 0, policy: 0, config: 1 });
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
  const { store, calls, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    await waitFor(() => calls.catalog === 1, "the first pass");
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

Deno.test("ServeCommitEffects: a follower reloads its policy only once the read model holds the commits that asked for it (swamp-club#4207)", async () => {
  // The leader's commits land in the copy, and move its head, before the
  // read model catches up: the policy loader reads the read model.
  let readModelGrants = 0;
  let landedGrants = 0;
  const seen: number[] = [];
  const { store, effects } = setup(true, {
    catchUpReadModel: () => {
      readModelGrants = landedGrants;
      return Promise.resolve();
    },
    reloadPolicy: () => {
      seen.push(readModelGrants);
      return Promise.resolve();
    },
  });
  try {
    landedGrants++;
    store.land(GRANT);
    await waitFor(() => seen.length > 0, "a policy reload");
    await effects.settled();
    assertEquals(seen, [1]);
    assertEquals(effects.appliedCursor(), 1);
    assertEquals(effects.policyKnown(), true);
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a follower's applied cursor moves only once a commit's effects are applied", async () => {
  let release: (() => void) | undefined;
  const { store, effects } = setup(true, {
    catchUpReadModel: () => new Promise<void>((done) => release = done),
  });
  const moves: number[] = [];
  const off = effects.onApplied(() => moves.push(effects.appliedCursor()));
  try {
    store.land(GRANT);
    await waitFor(() => release !== undefined, "the catch-up");
    assertEquals(effects.appliedCursor(), 0);
    release!();
    await effects.settled();
    assertEquals(effects.appliedCursor(), 1);
    assertEquals(moves, [1]);
  } finally {
    off();
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: after a replaced copy a follower's policy is unknown until the refresh pokes, then reloaded", async () => {
  const { store, calls, effects } = setup();
  try {
    store.land(GRANT);
    await waitFor(() => calls.policy === 1, "the first reload");
    await effects.settled();
    store.restored();
    await effects.settled();
    assertEquals(effects.policyKnown(), false);
    assertEquals(calls.policy, 1);
    effects.poke();
    await waitFor(() => calls.policy === 2, "the reload after the refresh");
    await effects.settled();
    assertEquals(effects.policyKnown(), true);
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a refresh that fails after a restore leaves the policy unknown only until a later refresh pokes", async () => {
  const { store, calls, effects } = setup();
  try {
    // The restore replaced the copy, then the refresh threw before it
    // poked: more commits land meanwhile, and the policy stays unknown.
    store.restored();
    await effects.settled();
    store.land(GRANT);
    await effects.settled();
    assertEquals(effects.policyKnown(), false);
    assertEquals(calls.policy, 0);
    // The next tick's refresh succeeds and pokes.
    effects.poke();
    await waitFor(() => effects.policyKnown(), "the policy reloaded");
    assertEquals(effects.appliedCursor(), 1);
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a reload that fails leaves a follower's policy unknown and its cursor in place, and the next pass retries it", async () => {
  let fail = true;
  const { store, calls, effects } = setup(true, {
    reloadPolicy: () =>
      fail ? Promise.reject(new Error("unreadable")) : Promise.resolve(),
  });
  try {
    store.land(GRANT);
    await waitFor(() => calls.policy === 1, "the failed reload");
    await effects.settled();
    assertEquals(effects.policyKnown(), false);
    assertEquals(effects.appliedCursor(), 0);
    fail = false;
    effects.poke();
    await waitFor(() => calls.policy === 2, "the retried reload");
    await effects.settled();
    assertEquals(effects.policyKnown(), true);
    assertEquals(effects.appliedCursor(), 1);
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a copy replaced below what was applied moves the applied cursor down to its head", async () => {
  const { store, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    await waitFor(() => effects.appliedCursor() === 2, "applied to 2");
    await effects.settled();
    store.replace(1);
    await effects.settled();
    assertEquals(effects.appliedCursor(), 1);
    assertEquals(effects.policyKnown(), false);
  } finally {
    await effects.stop();
  }
});

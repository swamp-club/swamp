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

/** A store of commits by partition, whose head the test moves. */
function fakeSource() {
  const rows: { cursor: number; partition: PartitionKey }[] = [];
  let compactedTo = 0;
  /** Past this cursor, the read model has not applied the commit. */
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
    /** Lands a commit the read model has not applied yet. */
    landUnapplied(partition: PartitionKey) {
      unappliedFrom ??= rows.at(-1)?.cursor ?? compactedTo;
      this.land(partition);
    },
    /** The read model catches up to the head. */
    applied() {
      unappliedFrom = undefined;
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

function setup(follower = true, slowPolicy = false) {
  const store = fakeSource();
  const calls = { catalog: 0, policy: 0, config: 0 };
  const gate = Promise.withResolvers<void>();
  const effects = new ServeCommitEffects({
    source: store.source,
    catalogInvalidate: () => calls.catalog++,
    reloadPolicy: () => {
      calls.policy++;
      return slowPolicy ? gate.promise : Promise.resolve();
    },
    checkConfig: () => calls.config++,
    isFollower: () => follower,
  });
  effects.start();
  return { store, calls, effects, release: () => gate.resolve() };
}

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
    effects.poke();
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
    effects.poke();
    await waitFor(() => calls.catalog === 1, "calls.catalog === 1");
    await effects.settled();
    assertEquals(calls, { catalog: 1, policy: 0, config: 0 });
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

Deno.test("ServeCommitEffects: a copy replaced behind what was read refreshes everything", async () => {
  const { store, calls, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    effects.poke();
    await waitFor(() => calls.catalog >= 1, "calls.catalog >= 1");
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
    effects.poke();
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

Deno.test("ServeCommitEffects: a follower reloads only once its copy is caught up, so a restore reads the restored grants", async () => {
  const { store, calls, effects } = setup();
  try {
    store.restored();
    store.landUnapplied(GRANT);
    await effects.settled();
    assertEquals(calls, { catalog: 0, policy: 0, config: 0 });
    store.applied();
    effects.poke();
    await waitFor(() => calls.policy === 1, "the policy reloaded");
  } finally {
    await effects.stop();
  }
});

Deno.test("ServeCommitEffects: a poke leaves a commit its read model has not applied for the poke after it", async () => {
  const { store, calls, effects } = setup();
  try {
    store.land(partitionOf({ kind: "run", workflowId: ID, runId: ID }));
    store.landUnapplied(GRANT);
    effects.poke();
    await waitFor(() => calls.catalog === 1, "the first pass");
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
    // Queued while the slow reload runs; it reruns during the restore.
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
  const calls = { catalog: 0, policy: 0, config: 0 };
  const effects = new ServeCommitEffects({
    source: store.source,
    catalogInvalidate: () => calls.catalog++,
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
    // onLead, before the role flips.
    effects.poke();
    await effects.settled();
    assertEquals(calls, { catalog: 1, policy: 1, config: 0 });
    follower = false;
    store.land(GRANT);
    await effects.settled();
    assertEquals(calls, { catalog: 1, policy: 1, config: 0 });
  } finally {
    await effects.stop();
  }
});

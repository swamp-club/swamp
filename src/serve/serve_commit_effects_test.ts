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

function setup(follower = true) {
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
  return { store, calls, effects };
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
    await waitFor(
      () => calls.policy === 1 && calls.config === 1,
      "a full refresh",
    );
  } finally {
    await effects.stop();
  }
});

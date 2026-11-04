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
import { leaseOp } from "../src/domain/datastore_v3/op.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { modelCommit } from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { ServeCommitEffects } from "../src/serve/serve_commit_effects.ts";
import {
  blobSaveOps,
  commitBody,
  countFeedReads,
  type FeedReads,
  partitionPath,
  post,
  seedHistory,
  type Server,
  sha256Hex,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

/** serve's follower wiring over the server's own copy */
function followerEffects(
  server: Server,
  calls: { policy: number },
): ServeCommitEffects {
  const store = server.v3.commitStore;
  return new ServeCommitEffects({
    source: {
      datastore: server.v3,
      onMoved: (listener) => store.onHeadMoved(listener),
    },
    reloadPolicy: () => {
      calls.policy++;
      return Promise.resolve();
    },
    checkConfig: () => {},
    isFollower: () => true,
  });
}

async function refreshAfterLeaderCommit(
  server: Server,
  effects: ServeCommitEffects,
  version: number,
  expectedSeq: number,
): Promise<void> {
  const content = new TextEncoder().encode(`leader output ${version}`);
  const landed = await post(
    partitionPath(server),
    "alice-token",
    commitBody({
      expectedSeq,
      txnId: crypto.randomUUID(),
      ops: await blobSaveOps(server, "vpc", version, content),
      chunks: [{ sha256: await sha256Hex(content), size: content.length }],
    }, [content]),
  );
  assertEquals(landed.status, 200, JSON.stringify(landed.json));
  await server.v3.catchUp();
  effects.poke();
  await effects.settled();
}

Deno.test({
  name:
    "v3 feed catalog: a peer's write and a grant change reach a follower's catalog and policy with no poller",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const store = server.v3.commitStore;
      const calls = { policy: 0 };
      const effects = followerEffects(server, calls);
      effects.start();
      try {
        await refreshAfterLeaderCommit(server, effects, 1, 0);
        assertEquals(
          server.v3.catalogStore.latestRowCountsByType().get(
            server.modelType.normalized,
          ),
          1,
          "the follower's catalog holds the peer's write",
        );
        assertEquals(calls.policy, 0);

        await store.append(modelCommit(
          1,
          [leaseOp({ holder: "serve", fence: store.writerFence() ?? 1 })],
          {
            partition: partitionOf({
              kind: "model",
              type: ModelType.create("swamp/grant"),
              id: "5a0f3c2e-7b14-4d6a-9e21-3c8b7a6f5d40",
            }),
            namespace: server.v3.namespace,
            fence: store.writerFence() ?? 1,
            txnId: crypto.randomUUID(),
          },
        ));
        await server.v3.catchUp();
        effects.poke();
        await waitFor(() => calls.policy === 1, "the policy reloaded");
      } finally {
        await effects.stop();
      }
    });
  },
});

async function followerReadsForOneLeaderCommitAfter(
  history: number,
): Promise<FeedReads> {
  let reads: FeedReads = { commits: -1, fromStart: -1 };
  await withServer(writer(), async (server) => {
    await seedHistory(server, history);
    const effects = followerEffects(server, { policy: 0 });
    effects.start();
    try {
      // a refresh before the measured one: what its effects pass leaves
      // behind is what the next refresh pays for
      await refreshAfterLeaderCommit(server, effects, 1, history);
      reads = await countFeedReads(server.v3.commitStore, async () => {
        await refreshAfterLeaderCommit(server, effects, 2, history + 1);
      });
    } finally {
      await effects.stop();
    }
  });
  return reads;
}

Deno.test({
  name:
    "v3 feed catalog: a follower's refresh reads only the leader's new commit, however long the history (swamp-club#4387)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const short = await followerReadsForOneLeaderCommitAfter(10);
    const long = await followerReadsForOneLeaderCommitAfter(1_000);
    // the read model and the effects pass each read the new commit once
    assertEquals(short, { commits: 2, fromStart: 0 });
    assertEquals(long, short);
  },
});

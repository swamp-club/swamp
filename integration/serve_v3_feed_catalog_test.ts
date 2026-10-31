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

/**
 * The pollers' work on a v3 serve follower, done by the commits it sees
 * (swamp-club#4120), against a real v3 commit log: the swamp-club#2863
 * cases (a peer's write and a grant change become visible to serve) with
 * no poller running. A peer's data commit rebuilds the follower's catalog;
 * a commit to a grant reloads its access policy, so a revoked grant stops
 * allowing access on the follower. Before, a follower loaded its policy
 * once, at boot.
 */

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
  partitionPath,
  post,
  sha256Hex,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

Deno.test({
  name:
    "v3 feed catalog: a peer's write and a grant change reach a follower's catalog and policy with no poller",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const store = server.v3.commitStore;
      const calls = { catalog: 0, policy: 0 };
      const effects = new ServeCommitEffects({
        source: {
          datastore: server.v3,
          onMoved: (listener) => store.onHeadMoved(listener),
        },
        catalogInvalidate: () => calls.catalog++,
        reloadPolicy: () => {
          calls.policy++;
          return Promise.resolve();
        },
        checkConfig: () => {},
        isFollower: () => true,
      });
      effects.start();
      try {
        // A peer's data write, through serve's datastore API.
        const content = new TextEncoder().encode("peer output");
        const landed = await post(
          partitionPath(server),
          "alice-token",
          commitBody({
            expectedSeq: 0,
            txnId: crypto.randomUUID(),
            ops: await blobSaveOps(server, "vpc", 1, content),
            chunks: [{
              sha256: await sha256Hex(content),
              size: content.length,
            }],
          }, [content]),
        );
        assertEquals(landed.status, 200, JSON.stringify(landed.json));
        await server.v3.catchUp();
        effects.poke();
        await waitFor(() => calls.catalog >= 1, "the catalog rebuilt");
        await effects.settled();
        assertEquals(calls.policy, 0);

        // A grant change: any commit to a grant's partition.
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

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
 * The datastore API on a serve follower in team mode (swamp-club#4096): a
 * write is refused with a retryable 503 that names the leader, a read is
 * answered from the follower's copy while it is fresh, and nothing is told
 * to a caller that did not authenticate.
 */

import { assertEquals } from "@std/assert";
import type { FollowerGate } from "../src/serve/follower_requests.ts";
import {
  blobSaveOps,
  commitBody,
  getJson,
  partitionPath,
  post,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

const LEADER = {
  instanceId: "leader-1",
  fence: 4,
  address: "http://10.0.0.7:9090",
  since: "2026-10-28T12:00:00.000Z",
};

function follower(stale = false): FollowerGate {
  return { role: "follower", leader: () => LEADER, isStale: () => stale };
}

Deno.test({
  name:
    "datastore API: a follower refuses a commit with a retryable 503 naming the leader, and lands nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      server.ctx.followerGate = follower();
      const refused = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "vpc", 1, new Uint8Array(0)),
          chunks: [],
        }),
      );
      assertEquals(refused.status, 503);
      assertEquals(refused.json.code, "serve_not_leader");
      assertEquals(refused.json.leader, LEADER);
      server.ctx.followerGate = undefined;
      const head = await getJson(
        `${partitionPath(server)}?after=0`,
        "alice-token",
      );
      assertEquals(head.json.head, 0);
    });
  },
});

Deno.test({
  name:
    "datastore API: a follower answers reads while its copy is fresh, and refuses them once it is stale",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      server.ctx.followerGate = follower();
      const fresh = await getJson(
        `${server.url}/changes?cursor=0`,
        "alice-token",
      );
      assertEquals(fresh.status, 200);
      server.ctx.followerGate = follower(true);
      const stale = await getJson(
        `${server.url}/changes?cursor=0`,
        "alice-token",
      );
      assertEquals(stale.status, 503);
      assertEquals(stale.json.code, "serve_not_leader");
    });
  },
});

Deno.test({
  name:
    "datastore API: a follower tells a caller that did not authenticate nothing of the leader",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      server.ctx.followerGate = follower();
      const refused = await getJson(
        `${server.url}/changes?cursor=0`,
        "no-such-token",
      );
      assertEquals(refused.status, 401);
      assertEquals(refused.json.leader, undefined);
    });
  },
});

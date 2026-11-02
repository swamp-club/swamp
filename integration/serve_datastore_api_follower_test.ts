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
import { SERVE_FOLLOWER_BEHIND_CODE } from "../src/domain/datastore_v3/serve_leader.ts";
import type { FollowerGate } from "../src/serve/follower_requests.ts";
import { grant } from "./serve_request_harness.ts";
import {
  blobSaveOps,
  commitBody,
  getJson,
  partitionPath,
  post,
  type Server,
  sha256Hex,
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

Deno.test({
  name:
    "datastore API: a follower pages changes only to the last commit whose effects it applied, and never moves the cursor past it (swamp-club#4207)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const empty = new Uint8Array(0);
      const emptySha = await sha256Hex(empty);
      for (const expectedSeq of [0, 1]) {
        const landed = await post(
          partitionPath(server),
          "alice-token",
          commitBody({
            expectedSeq,
            txnId: crypto.randomUUID(),
            ops: await blobSaveOps(server, "vpc", expectedSeq + 1, empty),
            chunks: [{ sha256: emptySha, size: 0 }],
          }, [empty]),
        );
        assertEquals(landed.status, 200, JSON.stringify(landed.json));
      }
      const head = server.v3.commitStore.highWaterMark().cursor;
      const leader = await getJson(
        `${server.url}/changes?cursor=0`,
        "alice-token",
      );
      assertEquals(leader.json.cursor, head);
      const applied = head - 1;
      server.ctx.followerGate = follower();
      server.ctx.commitFeed = {
        datastore: server.v3,
        bound: () => applied,
        onMoved: () => () => {},
      };
      const bounded = await getJson(
        `${server.url}/changes?cursor=0`,
        "alice-token",
      );
      assertEquals(bounded.status, 200);
      assertEquals(bounded.json.cursor, applied);
      const cursors = (bounded.json.changes as { cursor: number }[]).map((
        change,
      ) => change.cursor);
      assertEquals(cursors.every((cursor) => cursor <= applied), true);
      assertEquals(cursors.includes(applied), true);
      const rest = await getJson(
        `${server.url}/changes?cursor=${applied}`,
        "alice-token",
      );
      assertEquals(rest.json.changes, []);
      assertEquals(rest.json.cursor, applied);
    });
  },
});

async function landCommits(
  server: Server,
  from: number,
  to: number,
): Promise<void> {
  const empty = new Uint8Array(0);
  const emptySha = await sha256Hex(empty);
  for (let expectedSeq = from; expectedSeq < to; expectedSeq++) {
    const landed = await post(
      partitionPath(server),
      "alice-token",
      commitBody({
        expectedSeq,
        txnId: crypto.randomUUID(),
        ops: await blobSaveOps(server, "vpc", expectedSeq + 1, empty),
        chunks: [{ sha256: emptySha, size: 0 }],
      }, [empty]),
    );
    assertEquals(landed.status, 200, JSON.stringify(landed.json));
  }
}

async function readHeld(
  server: Server,
  query: string,
  partition = partitionPath(server),
): Promise<
  { status: number; json: Record<string, unknown>; retryAfter: string | null }
> {
  const response = await fetch(`${partition}?${query}`, {
    headers: { authorization: "Bearer alice-token" },
  });
  return {
    status: response.status,
    json: await response.json(),
    retryAfter: response.headers.get("retry-after"),
  };
}

Deno.test({
  name:
    "datastore API: a follower behind the caller's copy waits for its feed, then refuses with a retryable 503, never a head that reads as a rewind (swamp-club#4254)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await landCommits(server, 0, 1);
      server.ctx.followerGate = follower();
      let waits = 0;
      server.ctx.followerCatchUp = () => {
        waits++;
        return Promise.resolve("catching-up" as const);
      };
      const refused = await readHeld(server, "after=1&limit=1&held=2");
      assertEquals(refused.status, 503);
      assertEquals(refused.json.code, SERVE_FOLLOWER_BEHIND_CODE);
      assertEquals(refused.json.leader, undefined);
      assertEquals(refused.retryAfter, "1");
      assertEquals(waits, 1);
      const level = await readHeld(server, "after=0&limit=1&held=1");
      assertEquals(level.status, 200);
      assertEquals(level.json.head, 1);
      assertEquals(waits, 1);
      const old = await readHeld(server, "after=1");
      assertEquals(old.status, 200);
      assertEquals(old.json.head, 1);
      assertEquals(waits, 1);
      // A follower with no leader feed can never say it caught up, so it
      // answers as before, and the caller judges the head: a refusal it
      // could not lift would hide a real rewind for good.
      server.ctx.followerCatchUp = undefined;
      const noFeed = await readHeld(server, "after=1&limit=1&held=2");
      assertEquals(noFeed.status, 200);
      assertEquals(noFeed.json.head, 1);
      // So does one whose feed has been down past the bound: a refusal it
      // could not lift would hide a real rewind as well.
      server.ctx.followerCatchUp = () => Promise.resolve("stuck" as const);
      const stuck = await readHeld(server, "after=1&limit=1&held=2");
      assertEquals(stuck.status, 200);
      assertEquals(stuck.json.head, 1);
    });
  },
});

Deno.test({
  name:
    "datastore API: a follower that catches up while the caller waits answers it, and one caught up to a leader itself behind the caller answers as that leader would (swamp-club#4254)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await landCommits(server, 0, 1);
      server.ctx.followerCatchUp = async () => {
        server.ctx.followerGate = undefined;
        await landCommits(server, 1, 2);
        server.ctx.followerGate = follower();
        return "caught-up" as const;
      };
      server.ctx.followerGate = follower();
      const caughtUp = await readHeld(server, "after=1&limit=1&held=2");
      assertEquals(caughtUp.status, 200);
      assertEquals(caughtUp.json.head, 2);
      // Caught up to a leader that is itself behind the caller (a restore
      // within the same log): answered, so the caller still refuses it as
      // diverged, as it would the leader.
      server.ctx.followerCatchUp = () => Promise.resolve("caught-up" as const);
      const leaderBehind = await readHeld(server, "after=4&limit=1&held=5");
      assertEquals(leaderBehind.status, 200);
      assertEquals(leaderBehind.json.head, 2);
    });
  },
});

Deno.test({
  name:
    "datastore API: a leader answers a caller past its head without waiting, and a held seq that is not an integer is refused (swamp-club#4254)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await landCommits(server, 0, 1);
      server.ctx.followerCatchUp = () =>
        Promise.reject(new Error("a leader never waits on a feed"));
      const leader = await readHeld(server, "after=3&limit=1&held=4");
      assertEquals(leader.status, 200);
      assertEquals(leader.json.head, 1);
      server.ctx.followerGate = follower();
      for (const bad of ["-1", "x", "1.5", "9".repeat(20), ""]) {
        const refused = await readHeld(server, `after=0&held=${bad}`);
        assertEquals(refused.status, 400, bad);
        assertEquals(refused.json.code, "invalid_request");
      }
    });
  },
});

Deno.test({
  name:
    "datastore API: a follower refuses as behind only a caller who may read the partition (swamp-club#4254)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const workflowsOnly = grant({
      actions: ["read"],
      resource: { kind: "workflow", pattern: "*" },
    });
    await withServer([workflowsOnly], async (server) => {
      server.ctx.followerGate = follower();
      server.ctx.followerCatchUp = () =>
        Promise.resolve("catching-up" as const);
      const hidden = await readHeld(server, "after=0&held=9");
      assertEquals(hidden.status, 404);
      assertEquals(hidden.json.code, "not_found");
    });
  },
});

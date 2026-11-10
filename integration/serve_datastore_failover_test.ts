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
import { ServeUnreachableError } from "../src/infrastructure/datastore_v3/serve_upstream_errors.ts";
import { ServeDatastoreClient } from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import type { FollowerGate } from "../src/serve/follower_requests.ts";
import { modelPartition } from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { LeaderLink } from "../src/serve/leader_link.ts";
import {
  blobSaveOps,
  commitBody,
  partitionPath,
  post,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

/**
 * a node whose process is stopped: its kernel completes every handshake and
 * reads what is sent, and nothing ever answers
 */
function frozenNode(): { url: string; accepted: () => number; close(): void } {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns: Deno.Conn[] = [];
  const accepting = (async () => {
    try {
      for await (const conn of listener) {
        conns.push(conn);
        // drained so a sender never blocks on a full window
        conn.readable.pipeTo(new WritableStream()).catch(() => {});
      }
    } catch {
      // closed
    }
  })();
  return {
    url: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
    accepted: () => conns.length,
    close() {
      listener.close();
      for (const conn of conns) {
        try {
          conn.close();
        } catch {
          // already closed
        }
      }
      void accepting;
    },
  };
}

const neverTimesOut = () => new AbortController().signal;

Deno.test({
  name:
    "serve failover: a member's read and commit to a stopped node end at the response deadline, the read once more on a fresh connection",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const node = frozenNode();
    const client = new ServeDatastoreClient({
      baseUrl: node.url,
      responseBaseMs: 100,
      timeoutSignal: neverTimesOut,
    });
    try {
      const read = await assertRejects(
        () => client.changes(0, new AbortController().signal),
        ServeUnreachableError,
      );
      assertEquals(read.sent, "maybe");
      assertEquals(
        node.accepted(),
        2,
        "the read went again on a new connection",
      );
      await assertRejects(
        () =>
          client.acquireLock(
            "data/x/y/.lock",
            30_000,
            0,
            new AbortController().signal,
          ),
        ServeUnreachableError,
      );
    } finally {
      client.close();
      node.close();
    }
  },
});

Deno.test({
  name:
    "serve failover: a lock renewal its caller timed out against a stopped node leaves its connection, and the next request opens another",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const node = frozenNode();
    const client = new ServeDatastoreClient({
      baseUrl: node.url,
      httpClient: () => Deno.createHttpClient({}),
      timeoutSignal: neverTimesOut,
      responseBaseMs: 60_000,
    });
    try {
      await assertRejects(() =>
        client.renewLock("lease", 30_000, AbortSignal.timeout(100))
      );
      const before = node.accepted();
      await assertRejects(() =>
        client.releaseLock("lease", AbortSignal.timeout(100))
      );
      assertEquals(node.accepted(), before + 1);
    } finally {
      client.close();
      node.close();
    }
  },
});

Deno.test({
  name:
    "serve failover: a follower forwarding to a stopped leader refuses at its forward deadline, retryable and in flight, instead of holding the member",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const node = frozenNode();
    const leader = {
      instanceId: "stopped-leader",
      fence: 4,
      address: node.url,
      since: "2026-11-10T00:00:00.000Z",
    };
    const link = new LeaderLink({
      leader: () => leader,
      responseBaseMs: 100,
      commitResponseBaseMs: 100,
    });
    try {
      await withServer(writer(), async (server) => {
        const gate: FollowerGate = {
          role: "follower",
          leader: () => leader,
          isStale: () => false,
        };
        server.ctx.followerGate = gate;
        server.ctx.leaderLink = link;
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
        assertEquals(refused.json.inFlight, true);
      });
    } finally {
      link.close();
      node.close();
    }
  },
});

/** answers, after confirmCostMs, as serve does once a commit replicated */
function slowConfirmingNode(confirmCostMs: number) {
  return Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) => {
      await req.arrayBuffer();
      await new Promise((done) => setTimeout(done, confirmCostMs));
      return Response.json({ seq: 1 });
    },
  );
}

Deno.test({
  name:
    "serve failover: a commit whose confirm takes over 10 s still gets serve's reply, directly and through a follower's forward",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const node = slowConfirmingNode(10_500);
    const origin = `http://127.0.0.1:${(node.addr as Deno.NetAddr).port}`;
    const client = new ServeDatastoreClient({ baseUrl: origin });
    const link = new LeaderLink({
      leader: () => ({
        instanceId: "slow-leader",
        fence: 4,
        address: origin,
        since: "2026-11-10T00:00:00.000Z",
      }),
    });
    try {
      const reply = await client.postCommit(
        modelPartition(),
        { expectedSeq: 0, txnId: crypto.randomUUID(), ops: [] },
        [],
        new AbortController().signal,
      ).catch((error) => error);
      assertEquals(reply instanceof ServeUnreachableError, false);
      const forwarded = await link.forward(
        new Request(
          `http://follower.internal/api/v1/datastore/_default/partitions/p/commits`,
          { method: "POST", body: new Uint8Array(8) },
        ),
      );
      assertEquals(forwarded.status, 200);
      assertEquals((await forwarded.json()).seq, 1);
    } finally {
      client.close();
      link.close();
      await node.shutdown();
    }
  },
});

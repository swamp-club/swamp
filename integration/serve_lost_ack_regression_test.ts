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
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import {
  fencedLease,
  getJson,
  partitionPath,
  post,
  save,
  saveBody,
  type Server,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

await initializeLogging({});

function webPartition(server: Server): string {
  return partitionOf({
    kind: "model",
    type: server.modelType,
    id: server.model.id,
  }).toString();
}

function batchBody(
  header: { items: { partition: string }[]; release?: string },
  commits: readonly Uint8Array[],
): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const total = 4 + json.byteLength +
    commits.reduce((sum, commit) => sum + commit.byteLength, 0);
  const body = new Uint8Array(total);
  new DataView(body.buffer).setUint32(0, json.byteLength, false);
  body.set(json, 4);
  let offset = 4 + json.byteLength;
  for (const commit of commits) {
    body.set(commit, offset);
    offset += commit.byteLength;
  }
  return body;
}

/**
 * the feed source a replicating leader has: it pages up to the mark a
 * confirmed sync published, which a failed confirm leaves where it was
 */
function replicatingLeader(server: Server): { failing: boolean } {
  const state = { failing: false };
  let published = server.v3.commitStore.highWaterMark().cursor;
  server.ctx.confirmReplicated = () => {
    if (state.failing) {
      return Promise.reject(
        new Error("litestream sync: no space left on device"),
      );
    }
    published = server.v3.commitStore.highWaterMark().cursor;
    return Promise.resolve();
  };
  server.ctx.commitFeed = {
    datastore: server.v3,
    bound: () =>
      Math.min(server.v3.commitStore.highWaterMark().cursor, published),
    onMoved: () => () => {},
  };
  return state;
}

/** a datastore that does not replicate pages to its head */
function solo(server: Server): void {
  server.ctx.commitFeed = {
    datastore: server.v3,
    bound: () => server.v3.commitStore.highWaterMark().cursor,
    onMoved: () => () => {},
  };
}

async function unconfirmedBatch(
  server: Server,
  lease: string,
  txnId: string,
): Promise<void> {
  const reply = await post(
    `${server.url}/commits`,
    "alice-token",
    batchBody(
      { items: [{ partition: webPartition(server) }], release: lease },
      [await saveBody(server, 1, 0, { lease, txnId })],
    ),
  );
  assertEquals(reply.status, 200, JSON.stringify(reply.json));
  const [item] = reply.json.results as {
    status: number;
    body: Record<string, unknown>;
  }[];
  assertEquals(item.status, 503, JSON.stringify(item));
  assertEquals(item.body.seq, 1);
}

async function changedTxnIds(server: Server): Promise<string[]> {
  const changes = await getJson(
    `${server.url}/changes?cursor=0`,
    "alice-token",
  );
  assertEquals(changes.status, 200);
  return (changes.json.changes as { commit: { txnId: string } }[])
    .map((change) => change.commit.txnId);
}

async function partitionRead(
  server: Server,
  query = "after=0",
): Promise<{ head: number; txnIds: string[] }> {
  const read = await getJson(
    `${partitionPath(server)}?${query}`,
    "alice-token",
  );
  assertEquals(read.status, 200, JSON.stringify(read.json));
  return {
    head: read.json.head as number,
    txnIds: (read.json.commits as { txnId: string }[]).map((c) => c.txnId),
  };
}

Deno.test({
  name:
    "serve lost-ack: a replicating leader pages no commit whose confirm failed, by changes or by partition, until a confirm covers it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const replication = replicatingLeader(server);
      const lease = await fencedLease(server, "alice-token");
      const txnId = crypto.randomUUID();
      replication.failing = true;
      await unconfirmedBatch(server, lease.leaseId, txnId);

      assertEquals(await changedTxnIds(server), []);
      assertEquals(await partitionRead(server), { head: 0, txnIds: [] });

      replication.failing = false;
      const confirmed = await save(server, "alice-token", 2, 1, {
        lease: lease.leaseId,
      });
      assertEquals(confirmed.status, 200, JSON.stringify(confirmed.json));
      const changed = await changedTxnIds(server);
      assertEquals(changed.length, 2);
      assertEquals(changed[0], txnId);
      const read = await partitionRead(server);
      assertEquals(read.head, 2);
      assertEquals(read.txnIds[0], txnId);
    });
  },
});

Deno.test({
  name:
    "serve lost-ack: a caller holding a commit past the replicated mark is never told a head below it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const replication = replicatingLeader(server);
      const lease = await fencedLease(server, "alice-token");
      replication.failing = true;
      await unconfirmedBatch(server, lease.leaseId, crypto.randomUUID());
      const read = await partitionRead(server, "after=0&held=1");
      assertEquals(read.head, 1);
      assertEquals(read.txnIds.length, 1);
    });
  },
});

Deno.test({
  name:
    "serve lost-ack: a datastore that does not replicate pages every landed commit",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      solo(server);
      const landed = await save(server, "alice-token", 1, 0);
      assertEquals(landed.status, 200, JSON.stringify(landed.json));
      assertEquals((await changedTxnIds(server)).length, 1);
      const read = await partitionRead(server);
      assertEquals(read.head, 1);
      assertEquals(read.txnIds.length, 1);
    });
  },
});

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

import { assert, assertEquals } from "@std/assert";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { Commit } from "../src/domain/datastore_v3/commit.ts";
import { MAX_BATCH_COMMITS } from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import { grant } from "./serve_request_harness.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import {
  call,
  commitBody,
  fencedLease,
  getJson,
  member,
  modelKey,
  post,
  saveBody,
  type Server,
  sha256Hex,
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

/** `POST commits`: a header naming each commit's partition, then each commit */
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

interface BatchResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function postBatch(
  server: Server,
  token: string,
  commits: readonly Uint8Array[],
  options: { release?: string; partitions?: string[] } = {},
): Promise<
  { status: number; results: BatchResult[]; released: boolean; json: unknown }
> {
  const partitions = options.partitions ??
    commits.map(() => webPartition(server));
  const reply = await post(
    `${server.url}/commits`,
    token,
    batchBody({
      items: partitions.map((partition) => ({ partition })),
      ...(options.release === undefined ? {} : { release: options.release }),
    }, commits),
  );
  return {
    status: reply.status,
    results: (reply.json.results ?? []) as BatchResult[],
    released: reply.json.released === true,
    json: reply.json,
  };
}

async function definitionCommit(
  name: string,
  type: string,
): Promise<Uint8Array> {
  const content = new TextEncoder().encode(`name: ${name}\n`);
  const sha = await sha256Hex(content);
  return commitBody({
    expectedSeq: 0,
    txnId: crypto.randomUUID(),
    ops: [{
      kind: "put",
      intent: {
        kind: "definition.create",
        definition: { kind: "model", name },
      },
      key: `config/models/${type}/${name}.yaml`,
      blob: { sha256: sha, size: content.length },
    }],
    chunks: [{ sha256: sha, size: content.length }],
  }, [content]);
}

function countConfirms(server: Server): { count: number } {
  const confirms = { count: 0 };
  server.ctx.confirmReplicated = () => {
    confirms.count++;
    return Promise.resolve();
  };
  return confirms;
}

async function headOf(server: Server): Promise<number> {
  return (await server.v3.commitStore.head(
    server.v3.namespace,
    partitionOf({ kind: "model", type: server.modelType, id: server.model.id }),
  )).seq;
}

/** bob may lock and write web, and read nothing else */
function bobOnWeb(): Grant[] {
  return [
    ...writer(),
    grant({
      subject: { kind: "user", name: "bob" },
      actions: ["read", "write", "run"],
      resource: { kind: "model", pattern: "web" },
    }),
    grant({
      subject: { kind: "user", name: "bob" },
      actions: ["read"],
      resource: { kind: "data", pattern: "*" },
    }),
  ];
}

Deno.test({
  name:
    "datastore batch: commits land in order, are confirmed once together, and each is answered with the commit as serve stamped it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const confirms = countConfirms(server);
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      const batch = await postBatch(server, "alice-token", [
        await saveBody(server, 1, 0, { txnId: first }),
        await saveBody(server, 2, 1, { txnId: second }),
      ]);
      assertEquals(batch.status, 200, JSON.stringify(batch.json));
      assertEquals(batch.results.map((result) => result.status), [200, 200]);
      assertEquals(batch.results.map((result) => result.body.seq), [1, 2]);
      assertEquals(confirms.count, 1);
      const stamped = await Commit.fromJSON(batch.results[1].body.commit);
      assertEquals(stamped.txnId, second);
      assertEquals(stamped.principal, "user:caller");
      // the parent a copy checks its head against before taking the commit
      assertEquals(batch.results[1].body.parentTxnId, first);
      assertEquals(await headOf(server), 2);
    });
  },
});

Deno.test({
  name:
    "datastore batch: a refused commit is answered as the single route answers it; the commits before it land and none after it is tried",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const confirms = countConfirms(server);
      const batch = await postBatch(server, "alice-token", [
        await saveBody(server, 1, 0),
        // built on the head before the first, as a commit that lost a race
        await saveBody(server, 2, 0),
        await saveBody(server, 3, 2),
      ]);
      assertEquals(batch.status, 200, JSON.stringify(batch.json));
      assertEquals(batch.results.length, 2, "the third was not tried");
      assertEquals(batch.results[0].status, 200);
      const alone = await post(
        `${server.url}/partitions/${
          encodeURIComponent(webPartition(server))
        }/commits`,
        "alice-token",
        await saveBody(server, 2, 0),
      );
      assertEquals(batch.results[1].status, alone.status);
      assertEquals(batch.results[1].body.code, alone.json.code);
      assertEquals(confirms.count, 1, "what landed is still confirmed");
      assertEquals(await headOf(server), 1);
    });
  },
});

Deno.test({
  name:
    "datastore batch: each commit is authorized on its own; one the caller may not make is refused after the ones before it land",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(member(), async (server) => {
      const batch = await postBatch(server, "alice-token", [
        await saveBody(server, 1, 0),
        await definitionCommit("rogue", server.modelType.normalized),
      ], {
        partitions: [
          webPartition(server),
          partitionOf({
            kind: "config",
            definitionKind: "model",
            name: "rogue",
          }).toString(),
        ],
      });
      assertEquals(batch.status, 200, JSON.stringify(batch.json));
      assertEquals(batch.results.map((result) => result.status), [200, 403]);
      assertEquals(await headOf(server), 1);
    });
  },
});

Deno.test({
  name:
    "datastore batch: a batch ends the command's own lease once every commit landed and is confirmed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(bobOnWeb(), async (server) => {
      const lease = await fencedLease(server, "alice-token");
      const batch = await postBatch(server, "alice-token", [
        await saveBody(server, 1, 0, { lease: lease.leaseId }),
      ], { release: lease.leaseId });
      assertEquals(batch.results.map((result) => result.status), [200]);
      assertEquals(batch.released, true);
      assertEquals(server.locks.lease("user:caller", lease.leaseId), undefined);
      // the lock is free for the next caller at once
      const next = await call(server, "POST", "locks", "bob-token", {
        lockKey: modelKey(server),
        fenced: true,
      });
      assertEquals(next.status, 201, JSON.stringify(next.json));
    });
  },
});

Deno.test({
  name:
    "datastore batch: an explicit lease, another caller's lease, and the lease of a batch that did not all land are never ended by it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(bobOnWeb(), async (server) => {
      const explicit = await call(server, "POST", "locks", "alice-token", {
        lockKey: modelKey(server),
        fenced: true,
        holdMs: 60_000,
      });
      assertEquals(explicit.status, 201, JSON.stringify(explicit.json));
      const explicitId = explicit.json.leaseId as string;
      const kept = await postBatch(server, "alice-token", [
        await saveBody(server, 1, 0, { lease: explicitId }),
      ], { release: explicitId });
      assertEquals(kept.results.map((result) => result.status), [200]);
      assertEquals(kept.released, false);
      assert(server.locks.lease("user:caller", explicitId) !== undefined);
      await call(server, "DELETE", `locks/${explicitId}`, "alice-token");

      const bobs = await fencedLease(server, "bob-token");
      const named = await postBatch(server, "alice-token", [
        await saveBody(server, 2, 1),
      ], { release: bobs.leaseId });
      // bob's lease holds the partition, so alice's commit cannot land either
      assertEquals(named.results.map((result) => result.status), [409]);
      assertEquals(named.released, false);
      assert(server.locks.lease("user:bob", bobs.leaseId) !== undefined);
      await call(server, "DELETE", `locks/${bobs.leaseId}`, "bob-token");

      const own = await fencedLease(server, "alice-token");
      const partial = await postBatch(server, "alice-token", [
        await saveBody(server, 2, 1, { lease: own.leaseId }),
        await saveBody(server, 3, 0, { lease: own.leaseId }),
      ], { release: own.leaseId });
      assertEquals(partial.results.map((result) => result.status), [200, 409]);
      assertEquals(partial.released, false);
      assert(server.locks.lease("user:caller", own.leaseId) !== undefined);
    });
  },
});

Deno.test({
  name:
    "datastore batch: commits that land but cannot be confirmed are each answered as landed and unconfirmed, and the lease is kept",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      server.ctx.confirmReplicated = () =>
        Promise.reject(new Error("the replica could not be published"));
      const lease = await fencedLease(server, "alice-token");
      const batch = await postBatch(server, "alice-token", [
        await saveBody(server, 1, 0, { lease: lease.leaseId }),
        await saveBody(server, 2, 1, { lease: lease.leaseId }),
      ], { release: lease.leaseId });
      assertEquals(batch.results.map((result) => result.status), [503, 503]);
      assertEquals(batch.results.map((result) => result.body.seq), [1, 2]);
      assertEquals(batch.released, false);
      assert(server.locks.lease("user:caller", lease.leaseId) !== undefined);
    });
  },
});

Deno.test({
  name:
    "datastore batch: a batch over the commit limit, or with a header field serve does not take, is refused before anything lands",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const one = await saveBody(server, 1, 0);
      const tooMany = await postBatch(
        server,
        "alice-token",
        Array.from({ length: MAX_BATCH_COMMITS + 1 }, () => one),
      );
      assertEquals(tooMany.status, 400);
      const unknown = await post(
        `${server.url}/commits`,
        "alice-token",
        batchBody(
          {
            items: [{ partition: webPartition(server) }],
            principal: "user:root",
          } as never,
          [one],
        ),
      );
      assertEquals(unknown.status, 400);
      assertEquals(await headOf(server), 0);
    });
  },
});

Deno.test({
  name:
    "datastore lock catch-up: a lock is answered with the changes the caller's copy lacks, as GET changes answers that caller",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(bobOnWeb(), async (server) => {
      await post(
        `${server.url}/partitions/${
          encodeURIComponent(webPartition(server))
        }/commits`,
        "alice-token",
        await saveBody(server, 1, 0),
      );
      await post(
        `${server.url}/partitions/${
          encodeURIComponent(
            partitionOf({
              kind: "config",
              definitionKind: "model",
              name: "hidden",
            }).toString(),
          )
        }/commits`,
        "alice-token",
        await definitionCommit("hidden", server.modelType.normalized),
      );
      for (const token of ["alice-token", "bob-token"]) {
        const changes = await getJson(`${server.url}/changes?cursor=0`, token);
        const lock = await call(server, "POST", "locks", token, {
          lockKey: modelKey(server),
          fenced: true,
          catchUp: { cursor: 0 },
        });
        assertEquals(lock.status, 201, JSON.stringify(lock.json));
        const caughtUp = lock.json.catchUp as Record<string, unknown>;
        assertEquals(caughtUp.changes, changes.json.changes, token);
        assertEquals(caughtUp.cursor, changes.json.cursor, token);
        assertEquals(caughtUp.requested, { cursor: 0 });
        await call(
          server,
          "DELETE",
          `locks/${lock.json.leaseId as string}`,
          token,
        );
      }
    });
  },
});

Deno.test({
  name:
    "datastore lock catch-up: serve checks the anchor the caller names, and a malformed catch-up is refused before any lease is granted",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const txnId = crypto.randomUUID();
      await post(
        `${server.url}/partitions/${
          encodeURIComponent(webPartition(server))
        }/commits`,
        "alice-token",
        await saveBody(server, 1, 0, { txnId }),
      );
      const anchor = {
        namespace: server.v3.namespace,
        partition: webPartition(server),
        seq: 1,
      };
      const verdictOf = async (txn: string, seq = 1) => {
        const lock = await call(server, "POST", "locks", "alice-token", {
          lockKey: modelKey(server),
          fenced: true,
          catchUp: { cursor: 1, anchor: { ...anchor, seq, txnId: txn } },
        });
        assertEquals(lock.status, 201, JSON.stringify(lock.json));
        await call(
          server,
          "DELETE",
          `locks/${lock.json.leaseId as string}`,
          "alice-token",
        );
        return (lock.json.catchUp as { anchor: unknown }).anchor;
      };
      assertEquals(await verdictOf(txnId), { verdict: "held" });
      assertEquals(await verdictOf("another"), {
        verdict: "other-commit",
        serveTxnId: txnId,
      });
      assertEquals(await verdictOf(txnId, 5), {
        verdict: "behind",
        serveHead: 1,
      });

      const changes = await getJson(
        `${server.url}/changes?cursor=1&anchorNamespace=${
          encodeURIComponent(anchor.namespace)
        }&anchorPartition=${
          encodeURIComponent(anchor.partition)
        }&anchorSeq=1&anchorTxnId=another`,
        "alice-token",
      );
      assertEquals(changes.json.anchor, {
        verdict: "other-commit",
        serveTxnId: txnId,
      });
      const partial = await getJson(
        `${server.url}/changes?cursor=1&anchorSeq=1`,
        "alice-token",
      );
      assertEquals(partial.status, 400);

      const malformed = await call(server, "POST", "locks", "alice-token", {
        lockKey: modelKey(server),
        fenced: true,
        catchUp: { cursor: -1 },
      });
      assertEquals(malformed.status, 400);
      assertEquals(server.locks.list().length, 0, "no lease was granted");
    });
  },
});

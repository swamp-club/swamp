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
import { waitFor } from "@swamp-club/swamp-testing";
import { carriedBytesInFlightForTesting } from "../src/serve/datastore_api.ts";
import type { ChunkBatch } from "../src/domain/datastore_v3/chunk_store.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { UploadLedger } from "../src/infrastructure/datastore_v3/upload_ledger.ts";
import {
  blobSaveOps,
  commitBody,
  partitionPath,
  post,
  type Server,
  sha256Hex,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

interface PutProbe {
  active: number;
  maxActive: number;
  started: number;
}

/** wraps every batch's put; `around` runs in place of the real put's start */
function probePuts(
  server: Server,
  around: (probe: PutProbe, put: () => Promise<void>) => Promise<void>,
): PutProbe {
  const probe: PutProbe = { active: 0, maxActive: 0, started: 0 };
  const store = server.v3.chunkStore;
  const begin = store.beginBatch.bind(store);
  store.beginBatch = (namespace) => {
    const batch: ChunkBatch = begin(namespace);
    const put = batch.put.bind(batch);
    batch.put = async (sha256, bytes, signal) => {
      probe.started++;
      probe.active++;
      probe.maxActive = Math.max(probe.maxActive, probe.active);
      try {
        await around(probe, () => put(sha256, bytes, signal));
      } finally {
        probe.active--;
      }
    };
    return batch;
  };
  return probe;
}

async function fourBlobCommit(server: Server): Promise<Uint8Array> {
  const contents = [1, 2, 3, 4].map((n) =>
    new TextEncoder().encode(`carried chunk ${n} ${crypto.randomUUID()}`)
  );
  const ops: unknown[] = [];
  const chunks: { sha256: string; size: number }[] = [];
  for (const [index, content] of contents.entries()) {
    ops.push(...await blobSaveOps(server, "big", index + 1, content));
    chunks.push({ sha256: await sha256Hex(content), size: content.length });
  }
  return commitBody(
    { expectedSeq: 0, txnId: crypto.randomUUID(), ops, chunks },
    contents,
  );
}

Deno.test({
  name:
    "datastore API: a commit's carried chunks are stored while the rest are read, and the commit lands",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      let overlapped!: () => void;
      const second = new Promise<void>((resolve) => overlapped = resolve);
      const probe = probePuts(server, async (probe, put) => {
        if (probe.active >= 2) overlapped();
        // Bounded so a serial store fails the assertion below instead of hanging.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          second,
          new Promise((resolve) => timer = setTimeout(resolve, 2_000)),
        ]);
        clearTimeout(timer);
        await put();
      });
      const committed = await post(
        partitionPath(server),
        "alice-token",
        await fourBlobCommit(server),
      );
      assertEquals(committed.status, 200, JSON.stringify(committed.json));
      assertEquals(probe.started, 4);
      assert(probe.maxActive >= 2, `max puts at once: ${probe.maxActive}`);
      assertEquals(carriedBytesInFlightForTesting(), 0);
    });
  },
});

Deno.test({
  name:
    "datastore API: a failed carried-chunk store fails the commit, records nothing in the ledger and returns its bytes to the budget",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ledger = new UploadLedger();
    await withServer(writer(), async (server) => {
      const probe = probePuts(server, async (probe, put) => {
        if (probe.started === 2) throw new Error("bucket write failed");
        await put();
      });
      const refused = await post(
        partitionPath(server),
        "alice-token",
        await fourBlobCommit(server),
      );
      assert(refused.status >= 500, JSON.stringify(refused.json));
      assert(probe.started >= 2);
      assertEquals(ledger.size, 0);
      assertEquals(carriedBytesInFlightForTesting(), 0);
      const head = await server.v3.commitStore.readPartition(
        server.v3.namespace,
        partitionOf({
          kind: "model",
          type: server.modelType,
          id: server.model.id,
        }),
        1,
        1,
      );
      assertEquals(head.length, 0);
    }, ledger);
  },
});

Deno.test({
  name:
    "datastore API: a client that abandons a commit mid-store leaves no carried bytes held",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => release = resolve);
      const probe = probePuts(server, async (_probe, put) => {
        await held;
        await put();
      });
      const controller = new AbortController();
      const sent = fetch(partitionPath(server), {
        method: "POST",
        headers: {
          authorization: "Bearer alice-token",
          "content-type": "application/vnd.swamp.commit+v1",
        },
        body: await fourBlobCommit(server) as Uint8Array<ArrayBuffer>,
        signal: controller.signal,
      }).then((response) => response.body?.cancel(), () => {});
      await waitFor(() => probe.started >= 1, "a put to start");
      controller.abort();
      await sent;
      release();
      await waitFor(() => probe.active === 0, "the puts to settle");
      await waitFor(
        () => carriedBytesInFlightForTesting() === 0,
        "the carried bytes to be released",
      );
    });
  },
});

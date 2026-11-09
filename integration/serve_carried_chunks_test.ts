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
import {
  type ChunkBatch,
  ChunkStore,
} from "../src/domain/datastore_v3/chunk_store.ts";
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

Deno.test({
  name:
    "datastore API: a sender stalled mid-chunk holds none of the carried-bytes budget, so another commit still lands",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const stalled = await fourBlobCommit(server);
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      const controller = new AbortController();
      const sent = fetch(partitionPath(server), {
        method: "POST",
        headers: {
          authorization: "Bearer alice-token",
          "content-type": "application/vnd.swamp.commit+v1",
        },
        body: pipe.readable,
        duplex: "half",
        signal: controller.signal,
      } as RequestInit).then((response) => response.body?.cancel(), () => {});
      const writer = pipe.writable.getWriter();
      // all but the last bytes: serve is left reading the final chunk
      await writer.write(stalled.subarray(0, stalled.length - 4));
      try {
        assertEquals(carriedBytesInFlightForTesting(), 0);
        const other = await post(
          partitionPath(server),
          "alice-token",
          await fourBlobCommit(server),
        );
        assertEquals(other.status, 200, JSON.stringify(other.json));
        assertEquals(carriedBytesInFlightForTesting(), 0);
      } finally {
        controller.abort();
        await writer.abort().catch(() => {});
        await sent;
      }
    });
  },
});

Deno.test({
  name:
    "datastore API: a chunk upload whose client went away while its store ran on unstaged storage is not recorded as stored",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ledger = new UploadLedger();
    let ended = false;
    const reserve = ledger.reserve.bind(ledger);
    ledger.reserve = (principal, size, now) => {
      const admission = reserve(principal, size, now);
      if (!admission.allowed) return admission;
      const cancel = admission.reservation.cancel.bind(admission.reservation);
      admission.reservation.cancel = () => {
        ended = true;
        cancel();
      };
      return admission;
    };
    await withServer(writer(), async (server) => {
      // a bucket write that finishes whatever the request's signal says
      const unstaged = new ChunkStore(
        new Proxy(server.v3.storage, {
          get: (target, prop) => {
            if (prop === "stageChunks" || prop === "syncChunkDirectories") {
              return undefined;
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => release = resolve);
      let started = false;
      server.v3.chunkStore.beginBatch = (namespace) => {
        const batch = unstaged.beginBatch(namespace);
        const put = batch.put.bind(batch);
        batch.put = async (sha256, bytes) => {
          started = true;
          await held;
          await put(sha256, bytes, new AbortController().signal);
        };
        return batch;
      };
      const content = new TextEncoder().encode(`gone ${crypto.randomUUID()}`);
      const sha = await sha256Hex(content);
      const controller = new AbortController();
      // straight to the handler: over HTTP/1.1 a disconnect never aborts the request's signal
      const sent = server.handle(
        new Request(`${server.url}/chunks/${sha}`, {
          method: "PUT",
          headers: {
            authorization: "Bearer alice-token",
            "content-length": String(content.length),
          },
          body: content,
          signal: controller.signal,
        }),
      ).then((response) => response.body?.cancel(), () => {});
      await waitFor(() => started, "the store to start");
      controller.abort();
      release();
      await sent;
      await waitFor(() => ended, "the upload to end");
      assertEquals(ledger.size, 0);
    }, ledger);
  },
});

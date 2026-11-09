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
import { join } from "@std/path";
import {
  CHUNK_BYTES,
  ChunkStore,
} from "../src/domain/datastore_v3/chunk_store.ts";
import type { ChunkBatch } from "../src/domain/datastore_v3/chunk_store.ts";
import {
  dataKey,
  modelIntent,
  modelPartition,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  contextHook,
  unitOptions,
} from "../src/infrastructure/datastore_v3/commit_log_test_helpers.ts";
import { createCommitLogUnitOfWork } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import { ServeCatchUp } from "../src/infrastructure/datastore_v3/serve_catch_up.ts";
import { createServeCommitSink } from "../src/infrastructure/datastore_v3/serve_commit_sink.ts";
import {
  clearServeUnreachableLatches,
  ServeDatastoreClient,
} from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import {
  CachedServeStorage,
  ServeChunkStorage,
} from "../src/infrastructure/datastore_v3/serve_datastore_storage.ts";
import { removeTempDir } from "../src/infrastructure/datastore_v3/serve_upstream_test_helpers.ts";
import { ServeUpstreamState } from "../src/infrastructure/datastore_v3/serve_upstream_state.ts";
import { SqliteCommitOutbox } from "../src/infrastructure/datastore_v3/sqlite_commit_outbox.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { carriedBytesInFlightForTesting } from "../src/serve/datastore_api.ts";
import {
  type Server,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

const STORAGE_CALL_MS = 1_000;
const FLAT_TIMEOUT_MS = 500;

const NO_SYNC = {
  syncFile: () => Promise.resolve(),
  syncDirectory: () => Promise.resolve(),
};

/**
 * every chunk write at serve takes STORAGE_CALL_MS, as a far bucket's does;
 * unstaged, puts go straight to storage, as a bucket extension's do
 */
function slowStorage(
  server: Server,
  staged: boolean,
): { maxActive: number; puts: number } {
  const probe = { maxActive: 0, puts: 0 };
  let active = 0;
  const store = staged ? server.v3.chunkStore : new ChunkStore(
    new Proxy(server.v3.storage, {
      get: (target, prop) => {
        if (prop === "stageChunks") return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  const begin = store.beginBatch.bind(store);
  server.v3.chunkStore.beginBatch = (namespace) => {
    const batch: ChunkBatch = begin(namespace);
    const put = batch.put.bind(batch);
    batch.put = async (sha256, bytes, signal) => {
      probe.puts++;
      active++;
      probe.maxActive = Math.max(probe.maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, STORAGE_CALL_MS));
        await put(sha256, bytes, signal);
      } finally {
        active--;
      }
    };
    return batch;
  };
  return probe;
}

function largeContent(bytes: number): Uint8Array {
  const content = new Uint8Array(bytes);
  // distinct chunks, so none is deduplicated away
  for (let i = 0; i < bytes; i += 4096) content[i] = (i / 4096) % 251;
  return content;
}

for (const staged of [true, false]) {
  Deno.test({
    name:
      `serve large output: a member's 4-chunk output lands through a serve whose ${
        staged ? "staged" : "unstaged"
      } storage is slow, in one commit request, with chunks stored together and a deadline that grows with the upload`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withServer(writer(), async (server) => {
        const probe = slowStorage(server, staged);
        const origin = new URL(server.url).origin;
        const routes: string[] = [];
        const deadlines: number[] = [];
        const client = new ServeDatastoreClient({
          baseUrl: origin,
          token: "alice-token",
          timeoutMs: FLAT_TIMEOUT_MS,
          timeoutSignal: (ms) => {
            deadlines.push(ms);
            return AbortSignal.timeout(ms);
          },
          fetch: (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input);
            routes.push(`${init?.method ?? "GET"} ${url.pathname}`);
            return fetch(input, init);
          },
        });
        const dir = await Deno.makeTempDir({ prefix: "swamp-large-output-" });
        const store = SqliteCommitStore.open(join(dir, "commits.db"), {
          follower: true,
        });
        const state = ServeUpstreamState.open(join(dir, "serve_upstream.db"));
        const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
        const lifetime = new AbortController();
        try {
          const catchUp = new ServeCatchUp({
            client,
            commitStore: store,
            state,
            copyDir: dir,
            namespace: "",
          });
          const cache = new CachedServeStorage(
            join(dir, "datastore"),
            new ServeChunkStorage(client),
            NO_SYNC,
          );
          const sink = createServeCommitSink({
            client,
            commitStore: store,
            catchUp,
            chunkCache: cache,
            outbox,
            signal: () => lifetime.signal,
          });
          const uow = createCommitLogUnitOfWork(
            contextHook(),
            unitOptions(sink, cache),
          );
          await uow.stageOp({
            partition: modelPartition(),
            put: {
              intent: modelIntent({
                kind: "data.save",
                name: "big",
                version: 1,
              }),
              key: dataKey("big", 1),
              content: largeContent(4 * CHUNK_BYTES),
            },
          });
          await uow.commit();

          const commits = routes.filter((route) =>
            route.startsWith("POST") && route.endsWith("/commits")
          );
          assertEquals(commits.length, 1, routes.join("\n"));
          assertEquals(
            routes.filter((route) => route.endsWith("/chunks/has")).length,
            1,
          );
          assertEquals(
            routes.filter((route) => route.startsWith("PUT")).length,
            0,
            "every chunk travelled in the commit",
          );
          assertEquals(probe.puts, 4);
          assert(probe.maxActive >= 2, `max puts at once: ${probe.maxActive}`);
          assert(
            Math.max(...deadlines) > 4 * CHUNK_BYTES / 1024,
            `deadlines: ${deadlines.join(", ")}`,
          );
          assertEquals(carriedBytesInFlightForTesting(), 0);
        } finally {
          lifetime.abort();
          clearServeUnreachableLatches();
          client.close();
          state.close();
          await outbox.close();
          await store.close();
          await removeTempDir(dir);
        }
      });
    },
  });
}

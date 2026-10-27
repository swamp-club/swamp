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
 * Serve's chunk endpoints, as a serve-mode checkout reaches them through
 * `ServeChunkStorage` (swamp-club#3985), held to the published `storage/1`
 * conformance suite extension storages are held to.
 */

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { assertStorageConformance } from "@swamp-club/swamp-testing";
import { ServeDatastoreClient } from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import { ServeUpstreamError } from "../src/infrastructure/datastore_v3/serve_upstream_errors.ts";
import { ServeChunkStorage } from "../src/infrastructure/datastore_v3/serve_datastore_storage.ts";
import {
  member,
  type Server,
  sha256Hex,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

/** Opens clients onto `server` with `token`, and closes them all. */
function clients(server: Server, token: string) {
  const opened: ServeDatastoreClient[] = [];
  return {
    open(): ServeDatastoreClient {
      const client = new ServeDatastoreClient({
        baseUrl: new URL(server.url).origin,
        namespace: "",
        token,
      });
      opened.push(client);
      return client;
    },
    close(): void {
      for (const client of opened) client.close();
    },
  };
}

Deno.test({
  name:
    "ServeChunkStorage: serve's chunk endpoints pass the storage/1 conformance suite, less list, delete and other namespaces",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // A put that names no partition needs admin.
    await withServer(writer(), async (server) => {
      const opened = clients(server, "alice-token");
      try {
        await assertStorageConformance(
          () => new ServeChunkStorage(opened.open()),
          {
            // The unnamespaced datastore: serve's `_default`.
            namespace: "",
            unsupported: {
              list:
                "serve has no route to list chunks: chunk collection is serve's",
              delete:
                "serve has no route to delete chunks: chunk collection is serve's",
              namespaces:
                "one serve datastore API is bound to its datastore's namespace",
            },
          },
        );
      } finally {
        opened.close();
      }
    });
  },
});

Deno.test({
  name:
    "ServeChunkStorage: a team member's put that names no partition is refused, so checkouts never use it for their commits",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(member(), async (server) => {
      const opened = clients(server, "alice-token");
      try {
        const storage = new ServeChunkStorage(opened.open());
        const bytes = new TextEncoder().encode(
          `member chunk ${crypto.randomUUID()}`,
        );
        const sha256 = await sha256Hex(bytes);
        const signal = new AbortController().signal;
        const error = await assertRejects(() =>
          storage.put("", sha256, bytes, signal)
        );
        assertInstanceOf(error, ServeUpstreamError);
        assertEquals(error.status, 403);
        assertEquals(await storage.get("", sha256, signal), null);
      } finally {
        opened.close();
      }
    });
  },
});

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
 * The v3 writer lease bound at the datastore root of a non-filesystem
 * datastore (swamp-club#3364): a registered datastore type's provider hands
 * its writable datastore-wide control plane to the lease, and namespaced
 * checkouts syncing the same datastore neither see nor move its records.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import { datastoreTypeRegistry } from "../src/domain/datastore/datastore_type_registry.ts";
import type { DatastoreSyncService } from "../src/domain/datastore/datastore_sync_service.ts";
import { WriterLeaseBusyError } from "../src/domain/datastore_v3/writer_lease.ts";
import { datastoreWriterLeaseStore } from "../src/infrastructure/datastore_v3/datastore_writer_lease_store.ts";
import { v3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { registerTestDatastoreType } from "../src/infrastructure/testing/test_datastore_type.ts";

const TTL_MS = 30_000;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lease-root-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Marks, writes and pushes one file under `namespace`, as core does. */
async function pushFile(
  service: DatastoreSyncService,
  cacheDir: string,
  namespace: string,
  name: string,
): Promise<void> {
  const relPath = `${namespace}/data/${name}`;
  await service.pullChanged({ namespace });
  await service.markDirty({ relPath, namespace });
  await Deno.mkdir(join(cacheDir, namespace, "data"), { recursive: true });
  await Deno.writeTextFile(join(cacheDir, namespace, "data", name), name);
  await service.pushChanged({ namespace });
}

Deno.test("v3 writer lease: binds at the datastore root through the provider while namespaced checkouts sync", async () => {
  await withTempDir(async (dir) => {
    const remote = createInMemoryRemote({ controlPlane: true });
    const type = registerTestDatastoreType(remote);
    try {
      const provider = datastoreTypeRegistry.get(type.typeName)!
        .createProvider!({});
      const lease = v3WriterLease(
        datastoreWriterLeaseStore(provider, type.typeName),
        TTL_MS,
      );
      const hold = await lease.acquire({ maxWaitMs: 0 });
      try {
        // Two namespaces sync, write their own control records, and one
        // pushes twice, so its index exists before its second pull.
        for (const namespace of ["team-a", "team-b"]) {
          for (const round of [1, 2]) {
            const cacheDir = join(dir, `${namespace}-${round}`);
            const service = provider.createSyncService!(dir, cacheDir);
            await pushFile(service, cacheDir, namespace, `file-${round}`);
            const store = service.controlPlaneStore!();
            await store.put(
              `heartbeats/${namespace}-${round}`,
              new Uint8Array(),
            );
            assertEquals(
              await store.list("writer/"),
              [],
              "a namespaced checkout must not see the datastore-wide lease",
            );
          }
        }
        assertEquals(await hold.renew(), "held");

        const writerKeys = [...remote.controlPlaneRecords().keys()]
          .filter((key) => key.includes("/writer/")).sort();
        assert(writerKeys.length > 0);
        for (const key of writerKeys) {
          assert(
            key.startsWith("_control/writer/"),
            `lease record ${key} must be at the datastore root`,
          );
        }

        // A second process on the same datastore meets the same lease,
        // whichever namespace it would sync.
        const other = v3WriterLease(
          datastoreWriterLeaseStore(
            datastoreTypeRegistry.get(type.typeName)!.createProvider!({}),
            type.typeName,
          ),
          TTL_MS,
        );
        await assertRejects(
          () => other.acquire({ maxWaitMs: 0 }),
          WriterLeaseBusyError,
        );
      } finally {
        await hold.release();
      }
    } finally {
      type.dispose();
    }
  });
});

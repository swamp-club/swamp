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
 * Test-only wiring that plugs an in-memory remote from
 * `@swamp-club/swamp-testing` into swamp's datastore type registry, so
 * `requireInitializedRepo` builds its repositories, `markDirty` hook and
 * flush paths against the fake exactly as it would against S3 or GCS.
 *
 * Test-only: production code must never import this module or
 * `@swamp-club/swamp-testing`.
 *
 * @module
 */

import { join } from "@std/path";
import type { InMemoryRemote } from "@swamp-club/swamp-testing";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";

/** A registered test datastore type and its disposer. */
export interface TestDatastoreType {
  /** The per-run type name, `@test/remote-<uuid>`. */
  typeName: string;
  /** Unregisters the type. Call it in a `finally`. */
  dispose: () => void;
}

/** Options for {@link registerTestDatastoreType}. */
export interface TestDatastoreTypeOptions {
  /**
   * Called each time one of the type's locks is released, including at the
   * end of `withLock`, so a test can place pushes relative to lock release.
   */
  onLockRelease?: () => void;
}

/**
 * Registers a per-run `@test/remote-<uuid>` datastore type whose sync
 * service is `remote.connect(cachePath)`. The cache lives at
 * `<repoDir>/.test-cache`. Point a repo at it with
 * {@link configureTestDatastore}. When `remote` has a
 * `datastoreControlPlaneStore`, the provider offers it too.
 */
export function registerTestDatastoreType(
  remote:
    & Pick<InMemoryRemote, "connect">
    & Partial<Pick<InMemoryRemote, "datastoreControlPlaneStore">>,
  options: TestDatastoreTypeOptions = {},
): TestDatastoreType {
  const released = (): void => options.onLockRelease?.();
  const typeName = `@test/remote-${crypto.randomUUID()}`;
  datastoreTypeRegistry.register({
    type: typeName,
    name: "In-memory test remote",
    description: "Shared in-memory remote for sync tests",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: () => ({
        acquire: () => Promise.resolve(),
        release: () => {
          released();
          return Promise.resolve();
        },
        withLock: async <T>(fn: () => Promise<T>) => {
          try {
            return await fn();
          } finally {
            released();
          }
        },
        inspect: () => Promise.resolve(null),
        forceRelease: () => Promise.resolve(true),
      }),
      createVerifier: () => ({
        verify: () =>
          Promise.resolve({
            healthy: true,
            message: "ok",
            latencyMs: 1,
            datastoreType: typeName,
          }),
      }),
      resolveDatastorePath: (repoDir: string) => join(repoDir, ".test-store"),
      resolveCachePath: (repoDir: string) => join(repoDir, ".test-cache"),
      // The fake's push manifest is its own opaque type, not core's branded
      // PushManifest; core only hands it back to the same commitPush.
      createSyncService: (_repoDir: string, cachePath: string) =>
        remote.connect(cachePath) as unknown as DatastoreSyncService,
      ...(remote.datastoreControlPlaneStore
        ? {
          datastoreControlPlaneStore: () =>
            remote.datastoreControlPlaneStore!(),
        }
        : {}),
    }),
  });
  return {
    typeName,
    dispose: () => datastoreTypeRegistry.invalidateType(typeName),
  };
}

/**
 * Appends a `datastore:` block selecting `typeName` to the repo's
 * `.swamp.yaml`, as `swamp datastore setup extension` would.
 */
export async function configureTestDatastore(
  repoDir: string,
  typeName: string,
): Promise<void> {
  const markerPath = join(repoDir, ".swamp.yaml");
  const existing = await Deno.readTextFile(markerPath);
  const datastoreYaml = [
    "datastore:",
    `  type: '${typeName}'`,
    "  config:",
    "    bucket: test-bucket",
  ].join("\n");
  await Deno.writeTextFile(
    markerPath,
    existing.trimEnd() + "\n" + datastoreYaml + "\n",
  );
}

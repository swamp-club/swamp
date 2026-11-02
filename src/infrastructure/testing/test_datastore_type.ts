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
 * test-only: plugs an in-memory remote into the datastore type registry;
 * production code must never import this module or swamp-testing
 */

import { join } from "@std/path";
import type { ConnectOptions, InMemoryRemote } from "@swamp-club/swamp-testing";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  DistributedLock,
  LockOptions,
} from "../../domain/datastore/distributed_lock.ts";

export interface TestDatastoreType {
  typeName: string;
  dispose: () => void;
}

export interface TestDatastoreTypeOptions {
  typeName?: string;
  onLockRelease?: () => void;
  /**
   * replaces the type's lock, which never waits and whose inspect() reads null,
   * so a test can share one lock table between clones
   */
  createLock?: (options?: LockOptions) => DistributedLock;
  /**
   * unset by default, so the type never claims the v3 writer lease contract
   * unless a test asks it to
   */
  datastoreWideLease?: boolean;
  connect?: Omit<ConnectOptions, "instance">;
  /**
   * a v3 setup needs this to tell the bucket holds no v2 namespace; absent by
   * default
   */
  listNamespaces?: () => Promise<string[]>;
}

export function registerTestDatastoreType(
  remote:
    & Pick<InMemoryRemote, "connect">
    & Partial<
      Pick<
        InMemoryRemote,
        | "datastoreControlPlaneStore"
        | "storage"
        | "replicaTarget"
        | "replicaPaths"
      >
    >,
  options: TestDatastoreTypeOptions = {},
): TestDatastoreType {
  const released = (): void => options.onLockRelease?.();
  const typeName = options.typeName ?? `@test/remote-${crypto.randomUUID()}`;
  datastoreTypeRegistry.register({
    type: typeName,
    name: "In-memory test remote",
    description: "Shared in-memory remote for sync tests",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: (_datastorePath: string, lockOptions?: LockOptions) =>
        options.createLock?.(lockOptions) ?? {
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
        },
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
      // the fake's push manifest is its own opaque type, not core's branded
      // PushManifest; core only hands it back to the same commitPush
      createSyncService: (_repoDir: string, cachePath: string) =>
        remote.connect(
          cachePath,
          options.connect,
        ) as unknown as DatastoreSyncService,
      ...(options.datastoreWideLease !== undefined
        ? { datastoreWideLease: options.datastoreWideLease }
        : {}),
      ...(remote.datastoreControlPlaneStore
        ? {
          datastoreControlPlaneStore: () =>
            remote.datastoreControlPlaneStore!(),
        }
        : {}),
      ...(remote.storage ? { storage: () => remote.storage!() } : {}),
      ...(remote.replicaTarget
        ? { replicaTarget: () => remote.replicaTarget!() }
        : {}),
      ...(remote.replicaPaths
        ? { replicaPaths: () => remote.replicaPaths!() }
        : {}),
      ...(options.listNamespaces
        ? {
          listNamespaces: (_datastorePath: string) => options.listNamespaces!(),
        }
        : {}),
    }),
  });
  return {
    typeName,
    dispose: () => datastoreTypeRegistry.invalidateType(typeName),
  };
}

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

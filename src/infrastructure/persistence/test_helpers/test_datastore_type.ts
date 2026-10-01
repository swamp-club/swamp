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

/*
 * Wires an in-memory remote from @swamp-club/swamp-testing into swamp's
 * datastore type registry, so `requireInitializedRepo` on a repo whose
 * `.swamp.yaml` names the type connects to that remote end to end.
 *
 * Lives here rather than in the testing package because that package is
 * published standalone and cannot import `datastoreTypeRegistry`.
 */

import { basename, join } from "@std/path";
import type {
  InMemoryRemote,
  InMemoryRemoteSyncService,
} from "@swamp-club/swamp-testing";
import { datastoreTypeRegistry } from "../../../domain/datastore/datastore_type_registry.ts";
import type { DatastoreSyncService } from "../../../domain/datastore/datastore_sync_service.ts";

/** A registered test datastore type. Call {@link dispose} in a `finally`. */
export interface TestDatastoreType {
  /** The per-run type name, `@test/remote-<uuid>`. */
  readonly typeName: string;
  /** Append a datastore block naming this type to `<repoDir>/.swamp.yaml`. */
  configureRepo(repoDir: string): Promise<void>;
  /** Every sync service the provider has connected, in creation order. */
  connections(): InMemoryRemoteSyncService[];
  /** Remove the type from the registry. */
  dispose(): void;
}

/**
 * Registers a per-run datastore type whose provider connects each repo's
 * cache (`<repoDir>/.test-cache`) to `remote`. The lock is a no-op and the
 * verifier always reports healthy.
 */
export function registerTestDatastoreType(
  remote: InMemoryRemote,
): TestDatastoreType {
  const typeName = `@test/remote-${crypto.randomUUID()}`;
  const connected: InMemoryRemoteSyncService[] = [];

  datastoreTypeRegistry.register({
    type: typeName,
    name: "In-memory remote (test)",
    description: "Connects each repo cache to a shared in-memory remote",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: () => ({
        acquire: () => Promise.resolve(),
        release: () => Promise.resolve(),
        withLock: <T>(fn: () => Promise<T>) => fn(),
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
      createSyncService: (repoDir: string, cachePath: string) => {
        const service = remote.connect(cachePath, {
          instance: basename(repoDir),
        });
        connected.push(service);
        // The fake's manifest type is its own, not core's branded
        // PushManifest; core passes manifests through without reading them.
        return service as unknown as DatastoreSyncService;
      },
    }),
  });

  return {
    typeName,
    async configureRepo(repoDir) {
      // Mirrors what `swamp datastore setup extension` writes.
      const markerPath = join(repoDir, ".swamp.yaml");
      const existing = await Deno.readTextFile(markerPath);
      const datastoreYaml = [
        "datastore:",
        `  type: '${typeName}'`,
        "  config:",
        "    remote: in-memory",
      ].join("\n");
      await Deno.writeTextFile(
        markerPath,
        existing.trimEnd() + "\n" + datastoreYaml + "\n",
      );
    },
    connections() {
      return [...connected];
    },
    dispose() {
      datastoreTypeRegistry.invalidateType(typeName);
    },
  };
}

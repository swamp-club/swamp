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

// Vault and datastore type search list an extension type as it declares
// itself (swamp-club#3365). A cold index registers the type lazily, with no
// declared name and an empty catalog description; the type search commands
// import the lazy bundles before listing. This wires the real loader, catalog
// and registries together, on a first index and on a second, catalog-backed
// one.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import type { KindAdapter } from "../src/domain/extensions/kind_adapter.ts";
import { vaultKindAdapter } from "../src/domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../src/domain/extensions/datastore_kind_adapter.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import {
  ensureAllVaultTypesLoaded,
  getVaultTypes,
} from "../src/domain/vaults/vault_types.ts";
import { datastoreTypeRegistry } from "../src/domain/datastore/datastore_type_registry.ts";
import {
  ensureAllDatastoreTypesLoaded,
  getDatastoreTypes,
} from "../src/domain/datastore/datastore_types.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const VAULT_SOURCE = (type: string) => `
import { z } from "npm:zod@4";

export const vault = {
  type: "${type}",
  name: "Mock Vault",
  description: "File-backed mock vault for testing.",
  configSchema: z.object({ endpoint: z.string() }),
  createProvider(name: string, _config: { endpoint: string }) {
    const store: Record<string, string> = {};
    return {
      getName: () => name,
      get: (key: string) => Promise.resolve(store[key]),
      put: (key: string, value: string) => {
        store[key] = value;
        return Promise.resolve();
      },
      list: () => Promise.resolve(Object.keys(store)),
    };
  },
};
`;

const DATASTORE_SOURCE = (type: string) => `
import { z } from "npm:zod@4";

export const datastore = {
  type: "${type}",
  name: "Custom Store",
  description: "A sprocket-backed test datastore.",
  configSchema: z.object({ path: z.string() }),
  createProvider: (_config: Record<string, unknown>) => ({
    createLock: (_datastorePath: string) => ({
      acquire: async () => {},
      release: async () => {},
      withLock: async (fn: () => Promise<unknown>) => fn(),
      inspect: async () => null,
      forceRelease: async (_nonce: string) => false,
    }),
    createVerifier: () => ({
      verify: async () => ({
        healthy: true,
        message: "ok",
        latencyMs: 1,
        datastoreType: "${type}",
      }),
    }),
    resolveDatastorePath: (repoDir: string) => repoDir,
  }),
};
`;

interface TypeListing {
  type: string;
  name: string;
  description: string;
}

interface KindUnderTest {
  subdir: string;
  adapter: KindAdapter;
  source: (type: string) => string;
  declared: { name: string; description: string };
  registry: {
    setTypeLoader(loader: (type: string) => Promise<void>): void;
    invalidateType(type: string): void;
    clearLoadersForTesting(): void;
  };
  ensureAllLoaded: () => Promise<void>;
  list: () => TypeListing[];
}

const KINDS: Record<string, KindUnderTest> = {
  vault: {
    subdir: "vaults",
    adapter: vaultKindAdapter,
    source: VAULT_SOURCE,
    declared: {
      name: "Mock Vault",
      description: "File-backed mock vault for testing.",
    },
    registry: vaultTypeRegistry,
    ensureAllLoaded: () => ensureAllVaultTypesLoaded(),
    list: () => getVaultTypes(),
  },
  datastore: {
    subdir: "datastores",
    adapter: datastoreKindAdapter,
    source: DATASTORE_SOURCE,
    declared: {
      name: "Custom Store",
      description: "A sprocket-backed test datastore.",
    },
    registry: datastoreTypeRegistry,
    ensureAllLoaded: () => ensureAllDatastoreTypesLoaded(),
    list: () => getDatastoreTypes(),
  },
};

for (const [kind, k] of Object.entries(KINDS)) {
  Deno.test(`${kind} type search lists a cold-indexed extension type as declared, on a first and a second index`, async () => {
    const repoDir = await Deno.makeTempDir({ prefix: "swamp_3365_" });
    const sourceDir = join(repoDir, "extensions", k.subdir);
    await ensureDir(join(repoDir, ".swamp"));
    await ensureDir(sourceDir);
    const lockfilePath = join(repoDir, "upstream_extensions.json");
    await Deno.writeTextFile(lockfilePath, "{}");
    const type = `@test/declared-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeTextFile(join(sourceDir, "declared.ts"), k.source(type));

    const catalog = new ExtensionCatalogStore(
      join(repoDir, ".swamp", "_extension_catalog.db"),
    );
    const repository = new ExtensionRepository({
      catalog,
      lockfileRepository: await LockfileRepository.create(lockfilePath),
      repoRoot: repoDir,
    });
    const listed = () => {
      const found = k.list().find((t) => t.type === type);
      return found && { name: found.name, description: found.description };
    };
    const index = async () => {
      const loader = new ExtensionLoader(
        testDenoRuntime,
        k.adapter,
        repoDir,
        undefined,
        repository,
      );
      k.registry.setTypeLoader((t) => loader.loadSingleType(t));
      await loader.buildIndex(sourceDir, { indexOnly: true });
    };

    try {
      await index();
      // The bug: a lazy type is listed under its type id with no description.
      assertEquals(listed(), { name: type, description: "" });
      await k.ensureAllLoaded();
      assertEquals(listed(), k.declared);

      // A later process starts from the populated catalog and is lazy again.
      k.registry.invalidateType(type);
      await index();
      assertEquals(listed()?.name, type);
      await k.ensureAllLoaded();
      assertEquals(listed(), k.declared);
    } finally {
      k.registry.invalidateType(type);
      k.registry.clearLoadersForTesting();
      catalog.close();
      if (Deno.build.os === "windows") {
        await Deno.remove(repoDir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(repoDir, { recursive: true });
      }
    }
  });
}

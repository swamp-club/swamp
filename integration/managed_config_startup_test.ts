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
 * Integration tests for discovering datastore extensions on disk
 * (swamp-club#2483).
 *
 * In a managedConfig repo on an extension-backed datastore, the datastore
 * extension must load before the managed config base can resolve. The
 * extension here is a real on-disk fixture that the datastore loader scans,
 * bundles and registers; nothing lists it in a lockfile.
 */

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { configureExtensionLoaders } from "../src/cli/mod.ts";
import { ensureManagedConfigBase } from "../src/cli/repo_context.ts";
import {
  getManagedConfigBase,
  managedConfigLockfilePath,
  resetManagedConfigRegistry,
} from "../src/infrastructure/persistence/paths.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import { datastoreTypeRegistry } from "../src/domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../src/domain/reports/report_registry.ts";
import { webhookTypeRegistry } from "../src/domain/webhooks/webhook_type_registry.ts";
import {
  getAutoResolver,
  setAutoResolver,
} from "../src/domain/extensions/auto_resolver_context.ts";
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";

const DATASTORE_CODE = (typeId: string, cacheDir: string) => `
export const datastore = {
  type: "${typeId}",
  name: "Test Store",
  description: "An extension-backed test datastore",
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
        datastoreType: "${typeId}",
      }),
    }),
    resolveDatastorePath: (_repoDir: string) => ${JSON.stringify(cacheDir)},
    resolveCachePath: (_repoDir: string) => ${JSON.stringify(cacheDir)},
  }),
};
`;

/** Writes a pulled extension root with its manifest. */
async function writeExtension(
  root: string,
  name: string,
  kind: string,
  file: string,
  code: string,
): Promise<void> {
  const extRoot = join(root, ...name.split("/"));
  await ensureDir(join(extRoot, kind));
  await Deno.writeTextFile(
    join(extRoot, "manifest.yaml"),
    `manifestVersion: 1\nname: "${name}"\nversion: "1.0.0"\n`,
  );
  await Deno.writeTextFile(join(extRoot, kind, file), code);
}

/**
 * Configures the extension loaders for a temp managedConfig repo whose
 * datastore extension sits under `root` (or nowhere), runs `fn`, and
 * restores the process-global state it touched.
 */
async function withExtensionBackedRepo(
  root: "managed" | "legacy" | "none",
  fn: (repoDir: string, marker: RepoMarkerData, cacheDir: string) => Promise<
    void
  >,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_ds_on_disk_" });
  const cacheDir = join(repoDir, "cache");
  const datastoreType = `@t${crypto.randomUUID().slice(0, 8)}/store`;
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    repoId: crypto.randomUUID(),
    tools: [],
    datastore: { type: datastoreType, managedConfig: true },
  };
  const previousResolver = getAutoResolver();
  setAutoResolver(null);
  try {
    await new RepoMarkerRepository().write(RepoPath.create(repoDir), marker);
    if (root !== "none") {
      const pulledRoot = root === "managed"
        ? join(repoDir, ".swamp", "config", "pulled-extensions")
        : join(repoDir, ".swamp", "pulled-extensions");
      await writeExtension(
        pulledRoot,
        datastoreType,
        "datastores",
        "store.ts",
        DATASTORE_CODE(datastoreType, cacheDir),
      );
    }
    await configureExtensionLoaders(
      repoDir,
      marker,
      [],
      [],
      true,
      undefined,
      managedConfigLockfilePath(repoDir),
    );
    await fn(repoDir, marker, cacheDir);
  } finally {
    for (
      const registry of [
        modelRegistry,
        vaultTypeRegistry,
        datastoreTypeRegistry,
        reportRegistry,
        webhookTypeRegistry,
      ]
    ) {
      registry.clearLoadersForTesting();
    }
    datastoreTypeRegistry.invalidateType(datastoreType);
    resetManagedConfigRegistry();
    setAutoResolver(previousResolver);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

Deno.test("configureExtensionLoaders: a datastore extension on disk resolves the managed config base with no lockfile", async () => {
  await withExtensionBackedRepo(
    "managed",
    async (repoDir, marker, cacheDir) => {
      const resolved = await ensureManagedConfigBase(
        repoDir,
        marker,
        undefined,
        {
          autoResolve: false,
        },
      );
      assertEquals(resolved, true);
      assertPathEquals(
        getManagedConfigBase(repoDir) ?? "",
        join(cacheDir, "config"),
      );
    },
  );
});

Deno.test("configureExtensionLoaders: finds a datastore extension left under the legacy root after migrate", async () => {
  await withExtensionBackedRepo("legacy", async (repoDir, marker) => {
    assertEquals(
      await ensureManagedConfigBase(repoDir, marker, undefined, {
        autoResolve: false,
      }),
      true,
    );
  });
});

Deno.test("configureExtensionLoaders: with no datastore extension on disk the base stays unresolved", async () => {
  await withExtensionBackedRepo("none", async (repoDir, marker) => {
    assertEquals(
      await ensureManagedConfigBase(repoDir, marker, undefined, {
        autoResolve: false,
      }),
      false,
    );
  });
});

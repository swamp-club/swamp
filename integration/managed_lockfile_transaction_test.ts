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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { copy, ensureDir, exists, walk } from "@std/fs";
import { dirname, join } from "@std/path";
import "../src/domain/models/models.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { FileLock } from "../src/infrastructure/persistence/file_lock.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import {
  registerManagedConfig,
  resetManagedConfigRegistry,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import {
  clearLockfilePublishPending,
  markLockfilePublishPending,
  readLockfilePublishPending,
} from "../src/infrastructure/persistence/pending_lockfile_publish.ts";
import { readUpstreamExtensions } from "../src/infrastructure/persistence/upstream_extensions.ts";
import {
  ManagedLockfileTransaction,
  withManagedLockfileTransaction,
} from "../src/libswamp/extensions/managed_lockfile_transaction.ts";
import {
  type InstallContext,
  installExtension,
} from "../src/libswamp/extensions/pull.ts";
import { RemoveExtensionService } from "../src/libswamp/extensions/remove_extension_service.ts";

// swamp-club#2838: two checkouts share one datastore's config tier. A
// directory stands in for the bucket, copied whole on each fetch and
// publish, last-writer-wins, and a FileLock in it for the datastore global
// lock. Each checkout's extension writes run through a managed lockfile
// transaction, so a write from a stale cache never erases the other
// checkout's entries.

const VERSION = "2026.01.01.1";
const LOCKFILE = "upstream_extensions.json";

async function buildArchive(
  name: string,
  dependencies: string[] = [],
): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_2838_arc_" });
  try {
    const extDir = join(dir, "extension");
    await ensureDir(join(extDir, "models"));
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      `manifestVersion: 1\nname: "${name}"\nversion: "${VERSION}"\n` +
        `models:\n  - m.ts\n` +
        (dependencies.length > 0
          ? `dependencies:\n${dependencies.map((d) => `  - "${d}"\n`).join("")}`
          : ""),
    );
    await Deno.writeTextFile(
      join(extDir, "models", "m.ts"),
      `export const model = { type: "${name}/m", version: "${VERSION}", methods: {} };\n`,
    );
    await createTarGz(extDir, join(dir, "a.tar.gz"));
    return await Deno.readFile(join(dir, "a.tar.gz"));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

interface Checkout {
  repoDir: string;
  lockfilePath: string;
  /** Makes the next publishes fail, as an unreachable datastore would. */
  failPublish: { value: boolean };
  install(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  refresh(): Promise<void>;
  entries(): Promise<string[]>;
}

interface World {
  remoteDir: string;
  archives: Map<string, Uint8Array>;
  checkout(label: string): Promise<Checkout>;
  remoteEntries(): Promise<string[]>;
}

async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "swamp_2838_" });
  const remoteDir = join(root, "bucket");
  await ensureDir(join(remoteDir, "config"));
  const archives = new Map<string, Uint8Array>();
  const catalogs: ExtensionCatalogStore[] = [];

  const checkout = async (label: string): Promise<Checkout> => {
    const repoDir = join(root, label, "repo");
    const configBase = join(root, label, "cache", "config");
    const lockfilePath = join(configBase, LOCKFILE);
    await ensureDir(swampPath(repoDir));
    await ensureDir(configBase);
    registerManagedConfig(repoDir, true, configBase);
    const failPublish = { value: false };
    const catalog = new ExtensionCatalogStore(
      swampPath(repoDir, "_extension_catalog.db"),
    );
    catalogs.push(catalog);

    const transaction = () =>
      new ManagedLockfileTransaction({
        lockfilePath,
        lock: new FileLock(remoteDir, {
          lockKey: ".datastore.lock",
          maxWaitMs: 10_000,
          retryIntervalMs: 10,
        }),
        sync: {
          hydrate: async () => {
            await copy(join(remoteDir, "config"), configBase, {
              overwrite: true,
            });
          },
          publish: async () => {
            if (failPublish.value) throw new Error("datastore unreachable");
            await Deno.copyFile(
              lockfilePath,
              join(remoteDir, "config", LOCKFILE),
            );
          },
        },
        pending: {
          read: () => readLockfilePublishPending(repoDir),
          write: (delta) => markLockfilePublishPending(repoDir, delta),
          clear: () => clearLockfilePublishPending(repoDir),
        },
      });

    const context = async (): Promise<InstallContext> => ({
      getExtension: (name) =>
        Promise.resolve({ name, description: "", latestVersion: VERSION }),
      downloadArchive: (name) => Promise.resolve(archives.get(name)!),
      getChecksum: () => Promise.resolve(null),
      lockfileRepository: await LockfileRepository.create(lockfilePath),
      skillsDirs: [join(repoDir, ".claude", "skills")],
      repoDir,
      force: true,
      alreadyPulled: new Set(),
      depth: 0,
    });

    return {
      repoDir,
      lockfilePath,
      failPublish,
      install: async (name) => {
        const ctx = await context();
        await withManagedLockfileTransaction(
          transaction(),
          () => installExtension({ name, version: VERSION }, ctx),
        );
      },
      remove: async (name) => {
        const lockfileRepository = await LockfileRepository.create(
          lockfilePath,
        );
        const repository = new ExtensionRepository({
          catalog,
          lockfileRepository,
          repoRoot: repoDir,
        });
        await withManagedLockfileTransaction(
          transaction(),
          () =>
            new RemoveExtensionService({
              repository,
              lockfileRepository,
              repoDir,
            }).execute(name),
        );
      },
      refresh: () => transaction().refresh(),
      entries: async () =>
        Object.keys(await readUpstreamExtensions(lockfilePath)).sort(),
    };
  };

  try {
    await fn({
      remoteDir,
      archives,
      checkout,
      remoteEntries: async () =>
        Object.keys(
          await readUpstreamExtensions(join(remoteDir, "config", LOCKFILE)),
        ).sort(),
    });
  } finally {
    for (const catalog of catalogs) catalog.close();
    resetManagedConfigRegistry();
    if (Deno.build.os === "windows") {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(root, { recursive: true });
    }
  }
}

async function lockFilesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of walk(dir, { includeDirs: false })) {
    if (entry.name.endsWith(".lock")) found.push(entry.path);
  }
  return found;
}

Deno.test("managed lockfile: a pull from a stale cache keeps the other checkout's entry", async () => {
  await withWorld(async (w) => {
    w.archives.set("@test/x", await buildArchive("@test/x"));
    w.archives.set("@test/y", await buildArchive("@test/y"));
    const a = await w.checkout("a");
    const b = await w.checkout("b");

    await a.install("@test/x");
    // B has not fetched since A's write.
    assertEquals(await b.entries(), []);
    await b.install("@test/y");

    assertEquals(await w.remoteEntries(), ["@test/x", "@test/y"]);
    assertEquals(await b.entries(), ["@test/x", "@test/y"]);
  });
});

Deno.test("managed lockfile: a removal from a stale cache does not revert the other checkout's addition", async () => {
  await withWorld(async (w) => {
    w.archives.set("@test/x", await buildArchive("@test/x"));
    w.archives.set("@test/z", await buildArchive("@test/z"));
    const a = await w.checkout("a");
    const b = await w.checkout("b");

    await a.install("@test/x");
    await b.install("@test/z");
    // A's cache still lacks B's entry.
    assertEquals(await a.entries(), ["@test/x"]);
    await a.remove("@test/x");

    assertEquals(await w.remoteEntries(), ["@test/z"]);
  });
});

Deno.test("managed lockfile: a failed publish is replayed after the next fetch without dropping a peer's entry", async () => {
  await withWorld(async (w) => {
    w.archives.set("@test/w", await buildArchive("@test/w"));
    w.archives.set("@test/v", await buildArchive("@test/v"));
    const a = await w.checkout("a");
    const b = await w.checkout("b");

    a.failPublish.value = true;
    await assertRejects(
      () => a.install("@test/w"),
      Error,
      "datastore unreachable",
    );
    assertEquals(await w.remoteEntries(), []);
    assertEquals((await readLockfilePublishPending(a.repoDir)).kind, "delta");

    await b.install("@test/v");
    a.failPublish.value = false;
    await a.refresh();

    assertEquals(await w.remoteEntries(), ["@test/v", "@test/w"]);
    assertEquals((await readLockfilePublishPending(a.repoDir)).kind, "none");
  });
});

Deno.test("managed lockfile: a dependency another checkout installed is installed locally, not skipped", async () => {
  await withWorld(async (w) => {
    w.archives.set("@test/dep", await buildArchive("@test/dep"));
    w.archives.set("@test/app", await buildArchive("@test/app", ["@test/dep"]));
    const a = await w.checkout("a");
    const b = await w.checkout("b");

    await b.install("@test/dep");
    await a.install("@test/app");

    assertEquals(await w.remoteEntries(), ["@test/app", "@test/dep"]);
    const depEntry =
      (await readUpstreamExtensions(a.lockfilePath))["@test/dep"];
    assert(depEntry?.files && depEntry.files.length > 0);
    for (const file of depEntry.files) {
      assert(await exists(join(a.repoDir, file)), `missing ${file}`);
    }
  });
});

Deno.test("managed lockfile: no lock file is left in the synced config tier or the bucket", async () => {
  await withWorld(async (w) => {
    w.archives.set("@test/x", await buildArchive("@test/x"));
    const a = await w.checkout("a");
    await a.install("@test/x");
    await a.remove("@test/x");

    assertEquals(await lockFilesUnder(dirname(a.lockfilePath)), []);
    assertEquals(await lockFilesUnder(join(w.remoteDir, "config")), []);
  });
});

Deno.test("managed lockfile: a dependency whose entry points outside the repo counts as installed, not a path error", async () => {
  await withWorld(async (w) => {
    w.archives.set("@test/app", await buildArchive("@test/app", ["@test/old"]));
    // A pre-.swamp entry from SWAMP_MODELS_DIR outside the repo.
    const legacy = {
      "@test/old": {
        version: VERSION,
        pulledAt: "2026-01-01T00:00:00.000Z",
        files: ["../outside/models/old.ts"],
      },
    };
    await Deno.writeTextFile(
      join(w.remoteDir, "config", LOCKFILE),
      JSON.stringify(legacy),
    );
    const a = await w.checkout("a");

    await a.install("@test/app");

    assertEquals(await w.remoteEntries(), ["@test/app", "@test/old"]);
    assertEquals(
      (await readUpstreamExtensions(a.lockfilePath))["@test/old"],
      legacy["@test/old"],
    );
  });
});

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

// Two repositories, or two `swamp serve` nodes, sharing one filesystem
// datastore (swamp-club#2858). Each keeps its own SQLite catalog at
// `{repoDir}/.swamp/data/_catalog.db`, and a filesystem datastore has no sync
// service, so nothing used to tell one catalog about the other's writes: once
// populated, B never saw A's new items, kept returning old versions of items
// it knew, and still found items A had deleted.
//
// The fix: each catalog rewrites a token in `.catalog-writers/` at the
// datastore tier root after every data write (SharedDatastoreWriteTracker,
// attached by createCatalogStore). CatalogStore.isPopulated invalidates when
// another writer's token changed, DataQueryService.getLatestRecord prefers the
// on-disk latest marker over an unpopulated row, and a backfill that started
// before an invalidate does not mark the catalog populated.

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs/walk";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { CATALOG_WRITERS_DIR } from "../src/infrastructure/persistence/shared_datastore_write_tracker.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";

await initializeLogging({});

const type = ModelType.create("test/shared-filesystem");
const enc = (s: string) => new TextEncoder().encode(s);

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-shared-fs-catalog-" });
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

/** Initialises a repo, optionally on a shared filesystem datastore, and wires it as serve does. */
async function openRepo(
  repoDir: string,
  sharedDatastore?: string,
): Promise<RepositoryContext> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  if (sharedDatastore) {
    const marker = join(repoDir, ".swamp.yaml");
    const existing = await Deno.readTextFile(marker);
    await Deno.writeTextFile(
      marker,
      existing.trimEnd() +
        `\ndatastore:\n  type: filesystem\n  path: '${sharedDatastore}'\n`,
    );
  }
  const { repoContext } = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  return repoContext;
}

function item(name: string, garbageCollection = 100): Data {
  return Data.create({
    name,
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection,
    tags: { type: "resource", modelName: "shared" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
  });
}

async function names(repo: RepositoryContext): Promise<string[]> {
  const rows = await repo.dataQueryService.query(
    'modelName == "shared"',
  ) as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

/** Two repos A and B on one shared filesystem datastore; B's catalog is populated. */
async function withSharedPair(
  fn: (
    a: RepositoryContext,
    b: RepositoryContext,
    shared: string,
  ) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const shared = join(dir, "shared");
    const a = await openRepo(join(dir, "a"), shared);
    const b = await openRepo(join(dir, "b"), shared);
    try {
      await fn(a, b, shared);
    } finally {
      a.catalogStore.close();
      b.catalogStore.close();
    }
  });
}

Deno.test("shared filesystem datastore: B sees A's new item", async () => {
  await withSharedPair(async (a, b) => {
    await b.unifiedDataRepo.save(
      type,
      crypto.randomUUID(),
      item("b-item"),
      enc("b"),
    );
    assertEquals(await names(b), ["b-item"]);
    assert(b.catalogStore.isPopulated());

    await a.unifiedDataRepo.save(
      type,
      crypto.randomUUID(),
      item("a-item"),
      enc("a"),
    );

    assert(
      await b.dataQueryService.getLatestRecord("shared", "a-item") !== null,
    );
    assertEquals(await names(b), ["a-item", "b-item"]);
  });
});

Deno.test("shared filesystem datastore: B sees A's new version of an item B knows", async () => {
  await withSharedPair(async (a, b) => {
    const modelId = crypto.randomUUID();
    await b.unifiedDataRepo.save(type, modelId, item("known"), enc("v1"));
    await names(b);

    await a.unifiedDataRepo.save(type, modelId, item("known"), enc("v2"));

    assertEquals(
      (await b.dataQueryService.getLatestRecord("shared", "known"))?.version,
      2,
    );
  });
});

Deno.test("shared filesystem datastore: B stops returning an item A deleted", async () => {
  await withSharedPair(async (a, b) => {
    const modelId = crypto.randomUUID();
    await a.unifiedDataRepo.save(type, modelId, item("doomed"), enc("x"));
    assertEquals(await names(b), ["doomed"]);

    await a.unifiedDataRepo.delete(type, modelId, "doomed");

    assertEquals(
      await b.dataQueryService.getLatestRecord("shared", "doomed"),
      null,
    );
    assertEquals(await names(b), []);
  });
});

Deno.test("shared filesystem datastore: B sees a deferred write once A advances the latest marker", async () => {
  await withSharedPair(async (a, b) => {
    const modelId = crypto.randomUUID();
    await b.unifiedDataRepo.save(type, modelId, item("deferred"), enc("v1"));
    await names(b);

    const receipt = await a.unifiedDataRepo.saveDeferred(
      type,
      modelId,
      item("deferred"),
      enc("v2"),
    );
    assertEquals(
      (await b.dataQueryService.getLatestRecord("shared", "deferred"))?.version,
      1,
      "a deferred version is not the latest until its marker advances",
    );

    await a.unifiedDataRepo.advanceLatestMarkers([receipt]);
    assertEquals(
      (await b.dataQueryService.getLatestRecord("shared", "deferred"))?.version,
      2,
    );
  });
});

Deno.test("shared filesystem datastore: a rolled-back deferred write leaves B on the previous version", async () => {
  await withSharedPair(async (a, b) => {
    const modelId = crypto.randomUUID();
    await b.unifiedDataRepo.save(type, modelId, item("rolled"), enc("v1"));
    await names(b);

    const receipt = await a.unifiedDataRepo.saveDeferred(
      type,
      modelId,
      item("rolled"),
      enc("v2"),
    );
    await a.unifiedDataRepo.rollbackVersions([receipt]);

    assertEquals(
      (await b.dataQueryService.getLatestRecord("shared", "rolled"))?.version,
      1,
    );
    assertEquals(await names(b), ["rolled"]);
  });
});

Deno.test("shared filesystem datastore: A's garbage collection invalidates B's catalog", async () => {
  await withSharedPair(async (a, b) => {
    const modelId = crypto.randomUUID();
    for (const v of ["1", "2", "3"]) {
      await a.unifiedDataRepo.save(type, modelId, item("collected", 1), enc(v));
    }
    await names(b);
    assert(b.catalogStore.isPopulated());

    const result = await a.unifiedDataRepo.collectGarbage(type, modelId);
    assert(result.versionsRemoved > 0);

    assertEquals(b.catalogStore.isPopulated(), false);
    assertEquals(
      (await b.dataQueryService.getLatestRecord("shared", "collected"))
        ?.version,
      3,
    );
  });
});

Deno.test("shared filesystem datastore: B's own writes keep B's catalog populated", async () => {
  await withSharedPair(async (a, b) => {
    await names(b);
    assert(b.catalogStore.isPopulated());

    await b.unifiedDataRepo.save(
      type,
      crypto.randomUUID(),
      item("own"),
      enc("b"),
    );

    assert(b.catalogStore.isPopulated());
    assert(await a.dataQueryService.getLatestRecord("shared", "own") !== null);
  });
});

Deno.test("shared filesystem datastore: a backfill that started before A's write does not leave B marked populated", async () => {
  await withSharedPair(async (a, b) => {
    for (let i = 0; i < 20; i++) {
      await b.unifiedDataRepo.save(
        type,
        crypto.randomUUID(),
        item(`n${i}`),
        enc("x"),
      );
    }
    b.catalogStore.invalidate();

    // ensurePopulated reads the catalog generation synchronously, then walks
    // the disk; A's write and B's check land in between.
    const backfill = b.dataQueryService.ensurePopulated();
    a.catalogStore.recordLocalWrite();
    assertEquals(b.catalogStore.isPopulated(), false);
    await backfill;

    assertEquals(b.catalogStore.isPopulated(), false);
    await b.dataQueryService.ensurePopulated();
    assertEquals(b.catalogStore.isPopulated(), true);
  });
});

Deno.test("shared filesystem datastore: a repo-local datastore gets no writers directory", async () => {
  await withTempDir(async (dir) => {
    const repo = await openRepo(join(dir, "solo"));
    try {
      await repo.unifiedDataRepo.save(
        type,
        crypto.randomUUID(),
        item("solo"),
        enc("x"),
      );
      const found: string[] = [];
      for await (const entry of walk(dir, { includeFiles: false })) {
        if (entry.name === CATALOG_WRITERS_DIR) found.push(entry.path);
      }
      assertEquals(found, []);
    } finally {
      repo.catalogStore.close();
    }
  });
});

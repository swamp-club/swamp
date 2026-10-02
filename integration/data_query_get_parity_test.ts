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
 * Parity between `data get` and its documented `data query` equivalent
 * (swamp-club#2962), ahead of retiring `data get` for `data query`.
 *
 * `data get` reads the filesystem repository; `data query` reads the
 * `_catalog.db` catalog and loads bodies per row. For every item of one
 * fixture, `dataGet` and `DataQueryService.query('modelName == … && name ==
 * …')` must agree on presence, version and content, and `version >= 0` must
 * list the versions the repository holds. The fixture is checked on three
 * datastores:
 *
 * - the default filesystem datastore;
 * - a custom datastore that downloads everything on pull (in-memory remote,
 *   writer and reader repos), opened as repo_context opens it;
 * - a lazy-hydration datastore, wired by hand because the in-memory remote
 *   models neither `hydrateFile` nor `lazyHydration`: the reader holds only
 *   metadata, and a hook copies `raw` from the writer when first read.
 *
 * Each is checked again after a catalog invalidate and after the catalog
 * database is deleted and rebuilt.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { dirname, join, relative } from "@std/path";
import { copy, ensureDir, walk } from "@std/fs";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import { Data } from "../src/domain/data/data.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import type { UnifiedDataRepository } from "../src/domain/data/repositories.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { catalogDbPath } from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import {
  collect,
  createDataGetDeps,
  createLibSwampContext,
  dataGet,
  type DataGetEvent,
} from "../src/libswamp/mod.ts";

await initializeLogging({});

const MODEL_NAME = "parity-model";
const modelType = ModelType.create("test/query-get-parity");
const encoder = new TextEncoder();

/**
 * Every live data name the fixture writes. The retired "old-name" is left
 * out: data get follows its rename to "new-name" and data query does not, on
 * every datastore (swamp-club#2972).
 */
const ITEM_NAMES = ["single", "multi", "note", "blob", "new-name"];

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-query-get-parity-" });
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

function item(name: string, contentType: string): Data {
  return Data.create({
    name,
    contentType,
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "resource", modelName: MODEL_NAME },
    ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
  });
}

/**
 * Writes the fixture: a single-version JSON item, a three-version JSON item,
 * a text item, a binary item, and an item renamed after it was written.
 */
async function writeFixture(
  repo: UnifiedDataRepository,
  modelId: string,
): Promise<void> {
  const json = "application/json";
  await repo.save(
    modelType,
    modelId,
    item("single", json),
    encoder.encode('{"v":1}'),
  );
  for (const v of [1, 2, 3]) {
    await repo.save(
      modelType,
      modelId,
      item("multi", json),
      encoder.encode(`{"v":${v}}`),
    );
  }
  await repo.save(
    modelType,
    modelId,
    item("note", "text/plain"),
    encoder.encode("hello parity\n"),
  );
  await repo.save(
    modelType,
    modelId,
    item("blob", "application/octet-stream"),
    new Uint8Array([0x89, 0x00, 0xff, 0x10]),
  );
  await repo.save(
    modelType,
    modelId,
    item("old-name", json),
    encoder.encode('{"renamed":true}'),
  );
  await repo.rename(modelType, modelId, "old-name", "new-name");
}

/** What one reader sees, through both commands' code paths. */
interface ReaderView {
  repoDir: string;
  modelId: string;
  dataRepo: FileSystemUnifiedDataRepository;
  queryService: DataQueryService;
  definitionRepo: YamlDefinitionRepository;
}

interface Seen {
  present: boolean;
  version?: number;
  /** JSON bodies parsed, text bodies as text; undefined for binary. */
  content?: unknown;
}

async function seenByGet(view: ReaderView, name: string): Promise<Seen> {
  const deps = createDataGetDeps(
    view.repoDir,
    undefined,
    view.dataRepo,
    undefined,
    view.definitionRepo,
  );
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      modelIdOrName: MODEL_NAME,
      dataName: name,
      includeContent: true,
      repoDir: view.repoDir,
    }),
  );
  const last = events.at(-1)!;
  if (last.kind !== "completed") return { present: false };
  const data = last.data;
  let content: unknown;
  if (data.contentType === "application/json") {
    content = data.content === undefined ? {} : JSON.parse(data.content);
  } else if (data.contentType.startsWith("text/")) {
    content = data.content ?? "";
  }
  return { present: true, version: data.version, content };
}

async function seenByQuery(view: ReaderView, name: string): Promise<Seen> {
  const predicate = `modelName == "${MODEL_NAME}" && name == "${name}"`;
  const records = await view.queryService.query(predicate) as DataRecord[];
  if (records.length === 0) return { present: false };
  assertEquals(records.length, 1, `query returned several latest ${name}`);
  const [content] = await view.queryService.query(predicate, {
    select: "content",
  });
  const record = records[0];
  const isText = record.contentType === "application/json" ||
    record.contentType.startsWith("text/");
  return {
    present: true,
    version: record.version,
    content: isText ? content : undefined,
  };
}

async function assertParity(view: ReaderView, label: string): Promise<void> {
  for (const name of ITEM_NAMES) {
    // Query first: on a lazy datastore data get downloads the body, which
    // would hide a query that cannot.
    const byQuery = await seenByQuery(view, name);
    const byGet = await seenByGet(view, name);
    assertEquals(byQuery, byGet, `${label}: ${name}`);
    const versions = await view.queryService.query(
      `modelName == "${MODEL_NAME}" && name == "${name}" && version >= 0`,
      { select: "version" },
    ) as number[];
    const onDisk = byGet.present
      ? await view.dataRepo.listVersions(modelType, view.modelId, name)
      : [];
    assertEquals(
      [...versions].sort((a, b) => a - b),
      [...onDisk].sort((a, b) => a - b),
      `${label}: versions of ${name}`,
    );
  }
}

/** The single-version item every setup writes again to check a later pull. */
async function writeNewVersion(
  repo: UnifiedDataRepository,
  modelId: string,
): Promise<void> {
  await repo.save(
    modelType,
    modelId,
    item("single", "application/json"),
    encoder.encode('{"v":2}'),
  );
}

async function initRepo(repoDir: string, typeName?: string): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  if (typeName) await configureTestDatastore(repoDir, typeName);
}

/** Saves the same model definition (same id) into a repo. */
async function saveDefinition(
  repoDir: string,
  definition: Definition,
): Promise<YamlDefinitionRepository> {
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  await definitionRepo.save(modelType, definition);
  return definitionRepo;
}

type Unlocked = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;

/** Takes the model lock (pulling), invalidates as the CLI does, runs fn, then flushes. */
async function withModelLock<T>(
  repoDir: string,
  modelId: string,
  fn: (ctx: Unlocked) => Promise<T>,
): Promise<T> {
  const ctx = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  const lock = await acquireModelLocks(
    ctx.datastoreConfig,
    [{ modelType: modelType.normalized, modelId }],
    repoDir,
    ctx.syncService,
    ctx.repoContext.catalogStore,
  );
  if (lock.synced) ctx.repoContext.catalogStore.invalidate();
  try {
    return await fn(ctx);
  } finally {
    await lock.flush();
    await flushDatastoreSync();
    ctx.repoContext.catalogStore.close();
  }
}

/** Opens a repo without pulling, as the read-only `data get`/`data query` do. */
async function withReader(
  repoDir: string,
  modelId: string,
  definitionRepo: YamlDefinitionRepository,
  fn: (view: ReaderView, ctx: Unlocked) => Promise<void>,
): Promise<void> {
  const ctx = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  try {
    await fn({
      repoDir,
      modelId,
      dataRepo: ctx.repoContext.unifiedDataRepo,
      queryService: ctx.repoContext.dataQueryService,
      definitionRepo,
    }, ctx);
  } finally {
    ctx.repoContext.catalogStore.close();
  }
}

Deno.test("data query/get parity: filesystem datastore", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await initRepo(repoDir);
    const definition = Definition.create({ name: MODEL_NAME });
    const definitionRepo = await saveDefinition(repoDir, definition);

    await withReader(repoDir, definition.id, definitionRepo, async (view) => {
      await writeFixture(view.dataRepo, definition.id);
      await assertParity(view, "write-through");
    });

    await withReader(
      repoDir,
      definition.id,
      definitionRepo,
      async (view, ctx) => {
        await writeNewVersion(view.dataRepo, definition.id);
        ctx.repoContext.catalogStore.invalidate();
        await assertParity(view, "after invalidate");
      },
    );

    await Deno.remove(catalogDbPath(repoDir));
    await withReader(repoDir, definition.id, definitionRepo, async (view) => {
      await assertParity(view, "after catalog rebuild");
    });
  });
});

Deno.test("data query/get parity: custom datastore, full hydration", async () => {
  const remote = createInMemoryRemote();
  const { typeName, dispose } = registerTestDatastoreType(remote);
  try {
    await withTempDir(async (dir) => {
      const writer = join(dir, "writer");
      const reader = join(dir, "reader");
      await initRepo(writer, typeName);
      await initRepo(reader, typeName);
      const definition = Definition.create({ name: MODEL_NAME });
      await saveDefinition(writer, definition);
      const definitionRepo = await saveDefinition(reader, definition);

      await withModelLock(
        writer,
        definition.id,
        (ctx) => writeFixture(ctx.repoContext.unifiedDataRepo, definition.id),
      );
      // The reader pulls (invalidating its catalog) as a model run would,
      // then reads without pulling, as data get and data query do.
      await withModelLock(reader, definition.id, () => Promise.resolve());
      await withReader(
        reader,
        definition.id,
        definitionRepo,
        (view) => assertParity(view, "after pull"),
      );

      await withModelLock(
        writer,
        definition.id,
        (ctx) =>
          writeNewVersion(ctx.repoContext.unifiedDataRepo, definition.id),
      );
      await withModelLock(reader, definition.id, () => Promise.resolve());
      await withReader(
        reader,
        definition.id,
        definitionRepo,
        (view) => assertParity(view, "after a second pull"),
      );

      const ctx = await requireInitializedRepoUnlocked({
        repoDir: reader,
        outputMode: "json",
      });
      const dbPath = catalogDbPath(reader, ctx.datastoreResolver);
      ctx.repoContext.catalogStore.close();
      await Deno.remove(dbPath);
      await withReader(
        reader,
        definition.id,
        definitionRepo,
        (view) => assertParity(view, "after catalog rebuild"),
      );
    });
  } finally {
    dispose();
  }
});

/**
 * Copies the writer's data tree into the reader without `raw` files, as a
 * lazy pull does: metadata, `latest` markers and the version directories.
 */
async function lazyPull(writerData: string, readerData: string): Promise<void> {
  for await (const entry of walk(writerData, { includeDirs: false })) {
    const rel = relative(writerData, entry.path);
    if (entry.name === "raw" || entry.name.startsWith("_catalog.db")) {
      await ensureDir(dirname(join(readerData, rel)));
      continue;
    }
    await ensureDir(dirname(join(readerData, rel)));
    await copy(entry.path, join(readerData, rel), { overwrite: true });
  }
}

Deno.test("data query/get parity: hand-wired lazy hydration", async () => {
  await withTempDir(async (dir) => {
    const writerDir = join(dir, "writer");
    const readerDir = join(dir, "reader");
    await initRepo(writerDir);
    await initRepo(readerDir);
    const definition = Definition.create({ name: MODEL_NAME });
    await saveDefinition(writerDir, definition);
    const definitionRepo = await saveDefinition(readerDir, definition);

    await withReader(
      writerDir,
      definition.id,
      definitionRepo,
      (view) => writeFixture(view.dataRepo, definition.id),
    );
    const writerData = join(writerDir, ".swamp", "data");
    const readerData = join(readerDir, ".swamp", "data");
    await lazyPull(writerData, readerData);

    const hydrated: string[] = [];
    const openReader = () => {
      const catalog = new CatalogStore(catalogDbPath(readerDir));
      const dataRepo = new FileSystemUnifiedDataRepository(
        readerDir,
        undefined,
        catalog,
        undefined,
        async (absPath: string) => {
          const source = join(writerData, relative(readerData, absPath));
          try {
            await copy(source, absPath, { overwrite: true });
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) return false;
            throw error;
          }
          hydrated.push(relative(readerData, absPath));
          return true;
        },
      );
      const view: ReaderView = {
        repoDir: readerDir,
        modelId: definition.id,
        dataRepo,
        // As repo_context wires a custom datastore.
        queryService: new DataQueryService(catalog, dataRepo, {
          filterStaleRows: false,
        }),
        definitionRepo,
      };
      return { catalog, view };
    };

    const first = openReader();
    try {
      await assertParity(first.view, "after lazy pull");
      assert(hydrated.length > 0, "nothing was downloaded");

      await withReader(
        writerDir,
        definition.id,
        definitionRepo,
        (view) => writeNewVersion(view.dataRepo, definition.id),
      );
      await lazyPull(writerData, readerData);
      first.catalog.invalidate();
      await assertParity(first.view, "after a second lazy pull");
    } finally {
      first.catalog.close();
    }

    await Deno.remove(catalogDbPath(readerDir));
    const rebuilt = openReader();
    try {
      await assertParity(rebuilt.view, "after catalog rebuild");
    } finally {
      rebuilt.catalog.close();
    }
  });
});

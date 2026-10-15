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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DefaultDataLifecycleService } from "./data_lifecycle_service.ts";
import { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import { InMemoryUnifiedDataRepository } from "../../infrastructure/persistence/in_memory_data_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";

/** The exemption the retention context injects, kept local to the test. */
const isExempt = (modelType: string): boolean => modelType === "swamp/grant";

const TYPE = ModelType.create("test/retention");
const EXEMPT_TYPE = ModelType.create("swamp/grant");
const CONTENT = new TextEncoder().encode('{"k":"v"}');

function makeData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "resource", specName: name, modelName: "m" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "ref" },
  });
}

async function save(
  repo: UnifiedDataRepository,
  name: string,
  type: ModelType = TYPE,
  modelId = "model-1",
): Promise<Data> {
  const { version } = await repo.save(type, modelId, makeData(name), CONTENT);
  return (await repo.findByName(type, modelId, name, version))!;
}

/**
 * A cutoff after every version written so far and at or before every
 * version written after it. Waits (well under a millisecond) for the clock
 * to pass the newest version, rather than sleeping.
 */
function cutoffAfter(newest: Data): Date {
  const cutoff = newest.createdAt.getTime() + 1;
  while (Date.now() < cutoff) {
    // poll the clock until it reaches the cutoff
  }
  return new Date(cutoff);
}

function inMemory(): InMemoryUnifiedDataRepository {
  return new InMemoryUnifiedDataRepository(new CatalogStore(":memory:"));
}

function service(repo: UnifiedDataRepository): DefaultDataLifecycleService {
  return new DefaultDataLifecycleService(repo, {} as never);
}

Deno.test("deleteDataOlderThan: deletes a name whole when its latest version is older than the cutoff", async () => {
  const repo = inMemory();
  await save(repo, "old");
  const newest = await save(repo, "old");
  const cutoff = cutoffAfter(newest);

  const result = await service(repo).deleteDataOlderThan(cutoff, {
    dryRun: false,
    isExempt,
  });

  assertEquals(result.entriesDeleted, 1);
  assertEquals(result.versionsDeleted, 2);
  assertEquals(result.bytesReclaimed, CONTENT.length * 2);
  assertEquals(result.more, false);
  assertEquals(await repo.listVersions(TYPE, "model-1", "old"), []);
  assertEquals(repo.getLatestVersionSync(TYPE, "model-1", "old"), null);
});

Deno.test("deleteDataOlderThan: trims only the old versions when the latest is within retention", async () => {
  const repo = inMemory();
  await save(repo, "mixed");
  const v2 = await save(repo, "mixed");
  const cutoff = cutoffAfter(v2);
  await save(repo, "mixed");

  const result = await service(repo).deleteDataOlderThan(cutoff, {
    dryRun: false,
    isExempt,
  });

  assertEquals(result.entriesDeleted, 0);
  assertEquals(result.versionsDeleted, 2);
  assertEquals(await repo.listVersions(TYPE, "model-1", "mixed"), [3]);
  assertEquals(repo.getLatestVersionSync(TYPE, "model-1", "mixed"), 3);
});

Deno.test("deleteDataOlderThan: leaves data of retention-exempt model types alone", async () => {
  const repo = inMemory();
  const grant = await save(repo, "grant", EXEMPT_TYPE, "g-1");
  const cutoff = cutoffAfter(grant);

  const result = await service(repo).deleteDataOlderThan(cutoff, {
    dryRun: false,
    isExempt,
  });

  assertEquals(result.versionsDeleted, 0);
  assertEquals(await repo.listVersions(EXEMPT_TYPE, "g-1", "grant"), [1]);
});

Deno.test("deleteDataOlderThan: leaves a name with an in-flight deferred write alone", async () => {
  const repo = inMemory();
  await save(repo, "busy");
  const v1 = await repo.findByName(TYPE, "model-1", "busy", 1);
  await repo.saveDeferred(TYPE, "model-1", makeData("busy"), CONTENT);
  const cutoff = cutoffAfter(v1!);

  const result = await service(repo).deleteDataOlderThan(cutoff, {
    dryRun: false,
    isExempt,
  });

  assertEquals(result.versionsDeleted, 0);
  assertEquals(await repo.listVersions(TYPE, "model-1", "busy"), [1, 2]);
});

Deno.test("deleteDataOlderThan: stops at the limit and reports more", async () => {
  const repo = inMemory();
  let newest: Data | undefined;
  for (const name of ["a", "b", "c"]) newest = await save(repo, name);
  const cutoff = cutoffAfter(newest!);

  const first = await service(repo).deleteDataOlderThan(cutoff, {
    dryRun: false,
    isExempt,
    limit: 2,
  });
  assertEquals(first.versionsDeleted, 2);
  assertEquals(first.more, true);

  const second = await service(repo).deleteDataOlderThan(cutoff, {
    dryRun: false,
    isExempt,
    limit: 2,
  });
  assertEquals(second.versionsDeleted, 1);
  assertEquals(second.more, false);
  assertEquals((await repo.findAllGlobal()).length, 0);
});

Deno.test("deleteDataOlderThan: a dry run counts what it would delete and deletes nothing", async () => {
  const repo = inMemory();
  await save(repo, "whole");
  await save(repo, "trim");
  const old = await save(repo, "trim");
  const cutoff = cutoffAfter(old);
  await save(repo, "trim");

  const result = await service(repo).deleteDataOlderThan(cutoff, {
    dryRun: true,
    isExempt,
  });

  assertEquals(result.dryRun, true);
  assertEquals(result.entriesDeleted, 1);
  assertEquals(result.versionsDeleted, 3);
  assertEquals(await repo.listVersions(TYPE, "model-1", "whole"), [1]);
  assertEquals(await repo.listVersions(TYPE, "model-1", "trim"), [1, 2, 3]);
});

Deno.test("deleteDataOlderThan: ages out a name whose latest version is a deletion marker", async () => {
  const repo = inMemory();
  const v1 = await save(repo, "gone");
  await repo.save(
    TYPE,
    "model-1",
    v1.withDeletionMarker({ version: 2 }),
    CONTENT,
  );
  const marker = await repo.findByName(TYPE, "model-1", "gone", 2);
  const cutoff = cutoffAfter(marker!);

  const result = await service(repo).deleteDataOlderThan(cutoff, {
    dryRun: false,
    isExempt,
  });

  assertEquals(result.entriesDeleted, 1);
  assertEquals(await repo.listVersions(TYPE, "model-1", "gone"), []);
});

/** Runs `fn` with a filesystem repository and its catalog in a temp dir. */
async function withFsRepo(
  fn: (
    repo: FileSystemUnifiedDataRepository,
    catalog: CatalogStore,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-retention-test-" });
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  try {
    await fn(
      new FileSystemUnifiedDataRepository(dir, undefined, catalog),
      catalog,
    );
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function catalogVersions(catalog: CatalogStore, name: string): number[] {
  return [
    ...catalog.iterateFiltered("data_name = ?", [name]),
  ].map((row) => row.version).sort((a, b) => a - b);
}

Deno.test("deleteDataOlderThan: on the filesystem repository removes old versions and their catalog rows", async () => {
  await withFsRepo(async (repo, catalog) => {
    await save(repo, "whole");
    await save(repo, "trim");
    const old = await save(repo, "trim");
    await repo.save(EXEMPT_TYPE, "g-1", makeData("grant"), CONTENT);
    await save(repo, "busy");
    const busyOld = await repo.findByName(TYPE, "model-1", "busy", 1);
    await repo.saveDeferred(TYPE, "model-1", makeData("busy"), CONTENT);
    const cutoff = cutoffAfter(
      busyOld!.createdAt > old.createdAt ? busyOld! : old,
    );
    await save(repo, "trim");

    const result = await service(repo).deleteDataOlderThan(cutoff, {
      dryRun: false,
      isExempt,
    });

    assertEquals(result.entriesDeleted, 1);
    assertEquals(result.versionsDeleted, 3);
    assertEquals(await repo.listVersions(TYPE, "model-1", "whole"), []);
    assertEquals(catalogVersions(catalog, "whole"), []);
    assertEquals(await repo.listVersions(TYPE, "model-1", "trim"), [3]);
    assertEquals(catalogVersions(catalog, "trim"), [3]);
    assertEquals(repo.getLatestVersionSync(TYPE, "model-1", "trim"), 3);
    assertEquals(catalogVersions(catalog, "grant"), [1]);
    assertEquals(await repo.listVersions(TYPE, "model-1", "busy"), [1, 2]);
  });
});

Deno.test("deleteDataOlderThan: keeps a version written while the old name is being deleted", async () => {
  await withFsRepo(async (repo, catalog) => {
    await save(repo, "racy");
    const old = await save(repo, "racy");
    const cutoff = cutoffAfter(old);
    // A writer without the global lock (a serve run) adds version 3 once
    // retention has read the name and started deleting it.
    let wrote = false;
    const racing = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "delete") {
          return async (...args: Parameters<typeof repo.delete>) => {
            if (!wrote) {
              wrote = true;
              await save(target, "racy");
            }
            return await target.delete(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await service(racing).deleteDataOlderThan(cutoff, {
      dryRun: false,
      isExempt,
    });

    assertEquals(await repo.listVersions(TYPE, "model-1", "racy"), [3]);
    assertEquals(repo.getLatestVersionSync(TYPE, "model-1", "racy"), 3);
    assertEquals(catalogVersions(catalog, "racy"), [3]);
  });
});

Deno.test("findVersionsCreatedBefore: pages through the catalog oldest first", async () => {
  await withFsRepo(async (repo) => {
    let newest: Data | undefined;
    for (const name of ["a", "b", "c"]) newest = await save(repo, name);
    const cutoff = cutoffAfter(newest!);
    await save(repo, "fresh");

    const first = await repo.findVersionsCreatedBefore(cutoff, { limit: 2 });
    assertEquals(first.versions.map((v) => v.dataName), ["a", "b"]);
    const second = await repo.findVersionsCreatedBefore(cutoff, {
      limit: 2,
      cursor: first.cursor,
    });
    assertEquals(second.versions.map((v) => v.dataName), ["c"]);
    assertEquals(second.cursor, undefined);
  });
});

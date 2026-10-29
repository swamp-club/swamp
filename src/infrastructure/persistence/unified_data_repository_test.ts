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

import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join, relative, SEPARATOR } from "@std/path";
import { hostname } from "node:os";
import { processHostIdentity } from "../runtime/process.ts";
import {
  ACCEPTED_SHORT_CONTENT_TTL_MS,
  FileSystemUnifiedDataRepository,
  sortedSubdirectoryNames,
  VERSION_FLOOR_SUFFIX,
} from "./unified_data_repository.ts";
import { type CatalogRow, CatalogStore } from "./catalog_store.ts";
import { Data } from "../../domain/data/mod.ts";
import { createNamespace, SOLO_NAMESPACE } from "../../domain/data/mod.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type {
  RenameForward,
  UnreadableModelRecord,
} from "../../domain/data/repositories.ts";
import { computeLatestFlags } from "../../domain/data/data_query_service.ts";
import { UserError } from "../../domain/errors.ts";
import { PathTraversalError } from "./safe_path.ts";
import {
  observeDiagnosticPhase,
  withDiagnosticArea,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import { findSpan, withObservedSpans } from "../tracing/span_test_helpers.ts";
import type { AtomicWriteSync } from "./atomic_write.ts";
import { SyncFailedError } from "./sync_directory.ts";
import { runInUnitOfWork } from "./unit_of_work_scope.ts";
import { createCommitLogUnitOfWork } from "../datastore_v3/commit_log_unit_of_work.ts";
import {
  contextHook,
  MemorySink,
  unitOptions,
} from "../datastore_v3/commit_log_test_helpers.ts";
import { MemoryStorage } from "../../domain/datastore_v3/v3_test_helpers.ts";
import { captureUnreadableWarnings } from "./unreadable_records_test_helpers.ts";

const testType = ModelType.create("test/model");

/** Runs `fn` with a fresh repo dir and a catalog in it, removing both after. */
async function withTempRepo(
  fn: (repo: FileSystemUnifiedDataRepository) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  const catalogStore = new CatalogStore(join(dir, "_catalog.db"));
  try {
    await fn(new FileSystemUnifiedDataRepository(dir, undefined, catalogStore));
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("record reads: metadata and content symlinks cannot escape the requested model", async () => {
  await withTempRepo(async (repo) => {
    for (const model of ["own", "other"]) {
      await repo.save(
        testType,
        model,
        makeJsonData("state"),
        new TextEncoder().encode("{}"),
      );
    }
    for (const file of ["metadata.yaml", "raw"]) {
      const own = join(repo.getPath(testType, "own", "state", 1), file);
      const other = join(repo.getPath(testType, "other", "state", 1), file);
      await Deno.remove(own);
      await Deno.symlink(other, own, { type: "file" });
      await assertRejects(
        () =>
          file === "metadata.yaml"
            ? repo.findByName(testType, "own", "state", 1)
            : repo.getContent(testType, "own", "state", 1),
        PathTraversalError,
      );
    }
  });
});

Deno.test("getPath rejects dataName with path traversal", async () => {
  await withTempRepo((repo) => {
    try {
      repo.getPath(testType, "valid-model", "../escape", 1);
      throw new Error("Expected path traversal error");
    } catch (e) {
      assertStringIncludes(
        (e as Error).message,
        "Path traversal detected",
      );
    }
  });
});

Deno.test("getPath rejects modelId with path traversal", async () => {
  await withTempRepo((repo) => {
    try {
      repo.getPath(testType, "../escape", "valid-data", 1);
      throw new Error("Expected path traversal error");
    } catch (e) {
      assertStringIncludes(
        (e as Error).message,
        "Path traversal detected",
      );
    }
  });
});

Deno.test("getPath accepts valid modelId and dataName", async () => {
  await withTempRepo((repo) => {
    const path = repo.getPath(testType, "my-model-id", "my-data-name", 1);
    assertStringIncludes(path, "my-model-id");
    assertStringIncludes(path, "my-data-name");
  });
});

Deno.test("listVersions rejects dataName with path traversal", async () => {
  await withTempRepo(async (repo) => {
    await assertRejects(
      () => repo.listVersions(testType, "valid-model", "../escape"),
      Error,
      "Path traversal detected",
    );
  });
});

Deno.test("findAllForModel: warns and returns empty for model name instead of UUID", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const result = await repo.findAllForModel(testType, "my-model-name");
    assertEquals(result, []);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getContent: warns and returns null for model name instead of UUID", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const result = await repo.getContent(
      testType,
      "my-model-name",
      "some-data",
    );
    assertEquals(result, null);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

const owner = {
  ownerType: "model-method" as const,
  ownerRef: "test/model:test-method",
};

function makeData(name: string): Data {
  return Data.create({
    name,
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
}

Deno.test("concurrent allocateVersion returns unique versions", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("concurrent-alloc");
    const concurrency = 10;

    const results = await Promise.all(
      Array.from(
        { length: concurrency },
        () => repo.allocateVersion(testType, "model-1", data),
      ),
    );

    const versions = results.map((r) => r.version);
    const uniqueVersions = new Set(versions);
    assertEquals(
      uniqueVersions.size,
      concurrency,
      `Expected ${concurrency} unique versions, got ${uniqueVersions.size}: [${
        versions.join(", ")
      }]`,
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("concurrent save returns unique versions with distinct content", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("concurrent-save");
    const concurrency = 10;

    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => {
        const content = new TextEncoder().encode(`content-${i}`);
        return repo.save(testType, "model-1", data, content);
      }),
    );

    // All versions must be unique
    const versions = results.map((r) => r.version);
    const uniqueVersions = new Set(versions);
    assertEquals(
      uniqueVersions.size,
      concurrency,
      `Expected ${concurrency} unique versions, got ${uniqueVersions.size}: [${
        versions.join(", ")
      }]`,
    );

    // All content must be preserved
    for (const version of versions) {
      const saved = await repo.getContent(
        testType,
        "model-1",
        "concurrent-save",
        version,
      );
      assertEquals(saved !== null, true, `Version ${version} content is null`);
    }
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("save rejects reserved data name 'latest'", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("latest");
    const content = new TextEncoder().encode("test");

    await assertRejects(
      () => repo.save(testType, "model-1", data, content),
      Error,
      "reserved for internal use",
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("save rejects reserved data name case-insensitively", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("LATEST");
    const content = new TextEncoder().encode("test");

    await assertRejects(
      () => repo.save(testType, "model-1", data, content),
      Error,
      "reserved for internal use",
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("allocateVersion rejects reserved data name 'latest'", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("latest");

    await assertRejects(
      () => repo.allocateVersion(testType, "model-1", data),
      Error,
      "reserved for internal use",
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// ============================================================================
// Sync read methods
// ============================================================================

function makeJsonData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "resource" },
    ownerDefinition: owner,
  });
}

Deno.test("getLatestVersionSync reads latest symlink", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeJsonData("sync-latest");

    await repo.save(
      testType,
      "model-1",
      data,
      new TextEncoder().encode('{"v":1}'),
    );
    await repo.save(
      testType,
      "model-1",
      data,
      new TextEncoder().encode('{"v":2}'),
    );

    const latest = repo.getLatestVersionSync(
      testType,
      "model-1",
      "sync-latest",
    );
    assertEquals(latest, 2);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getLatestVersionSync returns null for missing data", async () => {
  await withTempRepo((repo) => {
    const result = repo.getLatestVersionSync(
      testType,
      "missing-model",
      "missing-data",
    );
    assertEquals(result, null);
  });
});

Deno.test("namespace defaults to SOLO_NAMESPACE and stamps catalog rows", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    assertEquals(repo.namespace, SOLO_NAMESPACE);

    await repo.save(
      testType,
      "model-1",
      makeData("solo-data"),
      new TextEncoder().encode("hi"),
    );

    const rows = [...catalogStore.iterate()];
    assertEquals(rows.length, 1);
    assertEquals(rows[0].namespace, "");
    catalogStore.close();
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("configured namespace round-trips into the catalog row", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      undefined,
      undefined,
      createNamespace("infra"),
    );
    assertEquals(repo.namespace, "infra");

    await repo.save(
      testType,
      "model-1",
      makeData("ns-data"),
      new TextEncoder().encode("hello"),
    );

    const rows = [...catalogStore.iterate()];
    assertEquals(rows.length, 1);
    assertEquals(rows[0].namespace, "infra");
    catalogStore.close();
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findByNameSync reads metadata", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeJsonData("sync-find");

    await repo.save(
      testType,
      "model-1",
      data,
      new TextEncoder().encode('{"key":"value"}'),
    );

    const result = repo.findByNameSync(testType, "model-1", "sync-find");
    assertExists(result);
    assertEquals(result.name, "sync-find");
    assertEquals(result.contentType, "application/json");
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findByNameSync returns null for missing data", async () => {
  await withTempRepo((repo) => {
    const result = repo.findByNameSync(
      testType,
      "missing-model",
      "missing-data",
    );
    assertEquals(result, null);
  });
});

Deno.test("listVersionsSync returns sorted version numbers", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeJsonData("sync-list");

    for (let i = 0; i < 3; i++) {
      await repo.save(
        testType,
        "model-1",
        data,
        new TextEncoder().encode(`{"i":${i}}`),
      );
    }

    const versions = repo.listVersionsSync(testType, "model-1", "sync-list");
    assertEquals(versions, [1, 2, 3]);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("listVersionsSync returns empty for missing data", async () => {
  await withTempRepo((repo) => {
    const versions = repo.listVersionsSync(
      testType,
      "missing-model",
      "missing-data",
    );
    assertEquals(versions, []);
  });
});

Deno.test("getContentSync reads content bytes", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeJsonData("sync-content");
    const content = new TextEncoder().encode('{"hello":"world"}');

    await repo.save(testType, "model-1", data, content);

    const result = repo.getContentSync(testType, "model-1", "sync-content");
    assertExists(result);
    assertEquals(new TextDecoder().decode(result), '{"hello":"world"}');
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getContentSync returns null for missing content", async () => {
  await withTempRepo((repo) => {
    const result = repo.getContentSync(
      testType,
      "missing-model",
      "missing-data",
    );
    assertEquals(result, null);
  });
});

Deno.test("findAllForModelSync returns all data items", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );

    const data1 = makeJsonData("item-a");
    const data2 = makeJsonData("item-b");

    await repo.save(
      testType,
      "model-1",
      data1,
      new TextEncoder().encode('{"a":1}'),
    );
    await repo.save(
      testType,
      "model-1",
      data2,
      new TextEncoder().encode('{"b":2}'),
    );

    const results = repo.findAllForModelSync(testType, "model-1");
    assertEquals(results.length, 2);
    const names = results.map((d) => d.name).sort();
    assertEquals(names, ["item-a", "item-b"]);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findAllForModelSync returns empty for missing model", async () => {
  await withTempRepo((repo) => {
    const results = repo.findAllForModelSync(testType, "missing-model");
    assertEquals(results, []);
  });
});

Deno.test("iterateForModel: yields what findAllForModel returns, following renames", async () => {
  await withTempRepo(async (repo) => {
    for (const name of ["item-a", "item-b", "item-c"]) {
      await repo.save(testType, "model-1", makeData(name), new Uint8Array([1]));
    }
    await repo.rename(testType, "model-1", "item-b", "item-d");

    const iterated = await Array.fromAsync(
      repo.iterateForModel(testType, "model-1"),
    );
    const all = await repo.findAllForModel(testType, "model-1");
    assertEquals(
      iterated.map((d) => [d.name, d.version]),
      all.map((d) => [d.name, d.version]),
    );
    assertEquals(iterated.map((d) => d.name).sort(), [
      "item-a",
      "item-c",
      "item-d",
    ]);
  });
});

Deno.test("iterateForModel: yields nothing for a missing model", async () => {
  await withTempRepo(async (repo) => {
    assertEquals(
      await Array.fromAsync(repo.iterateForModel(testType, "missing-model")),
      [],
    );
  });
});

Deno.test("iterateForModel: reads each name when asked, skipping one removed after listing", async () => {
  await withTempRepo(async (repo) => {
    for (const name of ["item-a", "item-b", "item-c"]) {
      await repo.save(testType, "model-1", makeData(name), new Uint8Array([1]));
    }
    const iterator = repo.iterateForModel(testType, "model-1")
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    assertEquals(first.value?.name, "item-a");

    // Removed after the names were listed, as bookkeeping GC can do.
    await Deno.remove(repo.getDataNameDir(testType, "model-1", "item-b"), {
      recursive: true,
    });

    const rest: string[] = [];
    for (
      let next = await iterator.next();
      !next.done;
      next = await iterator.next()
    ) {
      rest.push(next.value.name);
    }
    assertEquals(rest, ["item-c"]);
  });
});

Deno.test("findAllForType: returns data scoped to one model type", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );

    const otherType = ModelType.create("other/type");
    const data1 = makeJsonData("item-a");
    const data2 = makeJsonData("item-b");
    const data3 = makeJsonData("item-c");

    await repo.save(
      testType,
      "model-1",
      data1,
      new TextEncoder().encode('{"a":1}'),
    );
    await repo.save(
      otherType,
      "model-2",
      data2,
      new TextEncoder().encode('{"b":2}'),
    );
    await repo.save(
      testType,
      "model-3",
      data3,
      new TextEncoder().encode('{"c":3}'),
    );

    const results = await repo.findAllForType(testType);
    assertEquals(results.length, 2);
    const names = results.map((r) => r.data.name).sort();
    assertEquals(names, ["item-a", "item-c"]);
    for (const r of results) {
      assertEquals(r.modelType.normalized, testType.normalized);
    }
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findAllForType: returns empty for missing type directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );

    const results = await repo.findAllForType(
      ModelType.create("nonexistent/type"),
    );
    assertEquals(results, []);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findAllForType: reports a model whose metadata is empty when asked, and skips it otherwise", async () => {
  const tmpDir = await Deno.makeTempDir();
  const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
  const repo = new FileSystemUnifiedDataRepository(
    tmpDir,
    undefined,
    catalogStore,
  );
  try {
    const encode = (text: string) => new TextEncoder().encode(text);
    await repo.save(testType, "model-ok", makeJsonData("item-ok"), encode("1"));
    await repo.save(
      testType,
      "model-empty",
      makeJsonData("item-empty"),
      encode("2"),
    );
    await Deno.writeTextFile(
      join(
        repo.getDataNameDir(testType, "model-empty", "item-empty"),
        "1",
        "metadata.yaml",
      ),
      "",
    );

    const plain = await repo.findAllForType(testType);
    assertEquals(plain.map((r) => r.modelId), ["model-ok"]);

    const unreadable: UnreadableModelRecord[] = [];
    const results = await repo.findAllForType(testType, { unreadable });
    assertEquals(results.map((r) => r.modelId), ["model-ok"]);
    assertEquals(
      unreadable.map((r) => [r.modelId, r.dataName]),
      [["model-empty", "item-empty"]],
    );
    assert(unreadable[0].error instanceof SyntaxError);
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findAllForType: a data name that fails is reported by name, and the model's other data is still returned", async () => {
  const tmpDir = await Deno.makeTempDir();
  const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
  const repo = new FileSystemUnifiedDataRepository(
    tmpDir,
    undefined,
    catalogStore,
  );
  try {
    const encode = (text: string) => new TextEncoder().encode(text);
    await repo.save(testType, "model-1", makeJsonData("good"), encode("1"));
    await repo.save(testType, "model-1", makeJsonData("report"), encode("2"));
    await Deno.writeTextFile(
      join(
        repo.getDataNameDir(testType, "model-1", "report"),
        "1",
        "metadata.yaml",
      ),
      "",
    );

    const unreadable: UnreadableModelRecord[] = [];
    const results = await repo.findAllForType(testType, { unreadable });
    assertEquals(results.map((r) => r.data.name), ["good"]);
    assertEquals(
      unreadable.map((r) => [r.modelId, r.dataName]),
      [["model-1", "report"]],
    );

    // Without the option empty metadata reads as no data, as before.
    assertEquals(
      (await repo.findAllForType(testType)).map((r) => r.data.name),
      ["good"],
    );
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findAllForType: a version whose metadata.yaml is missing is reported as NotFound when asked, and reads as no data otherwise", async () => {
  const tmpDir = await Deno.makeTempDir();
  const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
  const repo = new FileSystemUnifiedDataRepository(
    tmpDir,
    undefined,
    catalogStore,
  );
  try {
    await repo.save(
      testType,
      "model-1",
      makeJsonData("item"),
      new TextEncoder().encode("1"),
    );
    await Deno.remove(
      join(
        repo.getDataNameDir(testType, "model-1", "item"),
        "1",
        "metadata.yaml",
      ),
    );

    assertEquals(await repo.findAllForType(testType), []);
    const unreadable: UnreadableModelRecord[] = [];
    assertEquals(await repo.findAllForType(testType, { unreadable }), []);
    assertEquals(
      unreadable.map((r) => [r.modelId, r.dataName]),
      [["model-1", "item"]],
    );
    assert(unreadable[0].error instanceof Deno.errors.NotFound);
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test({
  name:
    "findAllForType: a model directory it cannot list is reported with no data name",
  // chmod has no effect for root, and Windows has no POSIX modes.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    await repo.save(
      testType,
      "model-bad",
      makeJsonData("item"),
      new TextEncoder().encode("1"),
    );
    const modelDir = dirname(
      repo.getDataNameDir(testType, "model-bad", "item"),
    );
    await Deno.chmod(modelDir, 0o000);
    try {
      const unreadable: UnreadableModelRecord[] = [];
      assertEquals(await repo.findAllForType(testType, { unreadable }), []);
      assertEquals(
        unreadable.map((r) => [r.modelId, r.dataName]),
        [["model-bad", undefined]],
      );
      assert(unreadable[0].error instanceof Deno.errors.PermissionDenied);
    } finally {
      await Deno.chmod(modelDir, 0o755);
      catalogStore.close();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "findAllForType: reports a model it cannot read and still returns the rest",
  // chmod has no effect for root, and Windows has no POSIX modes.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const encode = (text: string) => new TextEncoder().encode(text);
    await repo.save(testType, "model-ok", makeJsonData("item-ok"), encode("1"));
    await repo.save(
      testType,
      "model-bad",
      makeJsonData("item-bad"),
      encode("2"),
    );
    const versionDir = join(
      repo.getDataNameDir(testType, "model-bad", "item-bad"),
      "1",
    );
    await Deno.chmod(versionDir, 0o000);
    try {
      // Without the option the unreadable model is skipped, as before.
      const plain = await repo.findAllForType(testType);
      assertEquals(plain.map((r) => r.modelId), ["model-ok"]);

      const unreadable: UnreadableModelRecord[] = [];
      const results = await repo.findAllForType(testType, { unreadable });
      assertEquals(results.map((r) => r.modelId), ["model-ok"]);
      assertEquals(
        unreadable.map((r) => [r.modelId, r.dataName]),
        [["model-bad", "item-bad"]],
      );
      assertEquals(unreadable[0].modelType.normalized, testType.normalized);
      assert(unreadable[0].error instanceof Deno.errors.PermissionDenied);
    } finally {
      await Deno.chmod(versionDir, 0o755);
      catalogStore.close();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

// Pins the markDirty contract from design/enablers/datastores.md: every public mutation
// that writes into the cache must call the sync service's markDirty hook before
// the write begins, so the fast-path sidecar cannot short-circuit past it, and
// again once the write has landed (swamp-club#2421), so a push that ran while
// the write was in flight cannot have cleared the mark for good. Also pins the
// per-call relPath granularity — pre-write notify sites (save, append,
// allocateVersion) pass the data-name directory because the version directory
// doesn't exist yet; finalizeVersion passes the version directory; delete
// passes the version dir or data-name dir based on whether a version was
// supplied; collectGarbage passes each version directory being removed
// (per-path, so the sync service can detect deletions).
//
// Regression coverage for the datastore fast-path contract violation that
// silently lost writes when the sidecar stayed clean.
Deno.test("mutations call markDirty before and after writing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: Array<string | undefined> = [];
    // Whether the marked path existed when the mark arrived.
    const existed: boolean[] = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      let present = false;
      try {
        if (relPath !== undefined) Deno.lstatSync(relPath);
        present = relPath !== undefined;
      } catch {
        // Absent.
      }
      existed.push(present);
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
    );

    // save → data-name directory (version not yet allocated): before the
    // directory exists, then again once the version is on disk.
    const data = makeData("mark-dirty-save");
    await repo.save(
      testType,
      "model-1",
      data,
      new TextEncoder().encode("hello"),
    );
    const saveDir = repo.getDataNameDir(testType, "model-1", "mark-dirty-save");
    assertEquals(calls, [saveDir, saveDir]);
    assertEquals(existed, [false, true]);

    // allocateVersion → data-name directory; finalizeVersion → version dir
    const data2 = makeData("mark-dirty-alloc");
    const { version, contentPath } = await repo.allocateVersion(
      testType,
      "model-1",
      data2,
    );
    const allocDir = repo.getDataNameDir(
      testType,
      "model-1",
      "mark-dirty-alloc",
    );
    assertEquals(calls.slice(2), [allocDir, allocDir]);
    assertEquals(existed.slice(2), [false, true]);
    await Deno.writeFile(contentPath, new TextEncoder().encode("direct"));
    await repo.finalizeVersion(testType, "model-1", data2, version);
    const finalDir = repo.getPath(
      testType,
      "model-1",
      "mark-dirty-alloc",
      version,
    );
    assertEquals(calls.slice(4), [finalDir, finalDir]);

    // append → data-name directory (matches save/allocateVersion granularity).
    // The mark fires before the streaming-configured check throws, so the
    // signal lands even though the operation aborts, and the after-mark
    // still follows the failure. Tolerate the throw.
    try {
      await repo.append(
        testType,
        "model-1",
        "mark-dirty-save",
        new TextEncoder().encode("more"),
      );
    } catch {
      // Expected — mark-dirty-save isn't streaming-configured.
    }
    assertEquals(calls.slice(6), [saveDir, saveDir]);
    const afterAppend = calls.length;

    // rename → old-name directory at entry and again at the end. Internal
    // save() emits its own per-path signals for the new name.
    await repo.rename(testType, "model-1", "mark-dirty-save", "mark-dirty-ren");
    if (calls.length < afterAppend + 3) {
      throw new Error(`rename did not call markDirty: ${calls.length}`);
    }
    assertEquals(
      calls[afterAppend],
      saveDir,
      "rename's first markDirty call must be old-name directory",
    );
    assertEquals(
      calls[calls.length - 1],
      saveDir,
      "rename's last markDirty call must be old-name directory",
    );
    // The inner save() emits a per-path signal for the new name. Verify by
    // looking for the new-name data-name directory in the subsequent calls.
    const renameTail = calls.slice(afterAppend + 1);
    const expectedRenameInner = repo.getDataNameDir(
      testType,
      "model-1",
      "mark-dirty-ren",
    );
    if (!renameTail.some((c) => c === expectedRenameInner)) {
      throw new Error(
        `rename's inner save() did not emit per-path signal for new name: ${
          JSON.stringify(renameTail)
        }`,
      );
    }
    const afterRename = calls.length;

    // delete with specific version → version directory; it is the name's
    // last version, so its latest marker goes too (swamp-club#3473). Each
    // is marked while present, then again once gone.
    await repo.delete(testType, "model-1", "mark-dirty-ren", 1);
    const renVersion = repo.getPath(testType, "model-1", "mark-dirty-ren", 1);
    const renLatest = join(
      repo.getDataNameDir(testType, "model-1", "mark-dirty-ren"),
      "latest",
    );
    assertEquals(calls.slice(afterRename), [
      renVersion,
      renVersion,
      renLatest,
      renLatest,
    ]);
    assertEquals(existed.slice(afterRename), [true, false, true, false]);

    // delete without version → latest marker file (data-name dir already
    // removed by the prior specific-version delete that left no versions;
    // listVersions returns [] so only the latest marker signal fires).
    await repo.delete(testType, "model-1", "mark-dirty-ren");
    assertEquals(calls.slice(afterRename + 4), [renLatest, renLatest]);

    // collectGarbage (live) with nothing to GC → no markDirty calls
    await repo.collectGarbage(testType, "model-1");
    assertEquals(
      calls.length,
      afterRename + 6,
      "collectGarbage with no excess versions must not call markDirty",
    );

    // collectGarbage (dry-run) must not notify — it does not touch the cache
    const before = calls.length;
    await repo.collectGarbage(testType, "model-1", { dryRun: true });
    assertEquals(calls.length, before);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("delete: full delete emits per-version markDirty signals", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
    );

    const data = makeData("multi-ver");
    await repo.save(testType, "m1", data, new TextEncoder().encode("v1"));
    await repo.save(testType, "m1", data, new TextEncoder().encode("v2"));
    await repo.save(testType, "m1", data, new TextEncoder().encode("v3"));
    calls.length = 0;

    await repo.delete(testType, "m1", "multi-ver");

    // Must emit one signal per version directory + one for the latest
    // marker, before the removal and again after it (swamp-club#2421).
    const expectedVersionPaths = [1, 2, 3].map((v) =>
      repo.getPath(testType, "m1", "multi-ver", v)
    );
    const expectedLatest = join(
      repo.getDataNameDir(testType, "m1", "multi-ver"),
      "latest",
    );
    const expected = [...expectedVersionPaths, expectedLatest];
    assertEquals(calls, [...expected, ...expected]);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("delete: deleting the last version also signals the latest marker's removal", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
    );
    const data = makeData("last-ver");
    await repo.save(testType, "m1", data, new TextEncoder().encode("v1"));
    await repo.save(testType, "m1", data, new TextEncoder().encode("v2"));
    calls.length = 0;

    await repo.delete(testType, "m1", "last-ver", 1);
    // An older version leaves the marker in place.
    const latest = join(
      repo.getDataNameDir(testType, "m1", "last-ver"),
      "latest",
    );
    assertEquals(calls.includes(latest), false);

    await repo.delete(testType, "m1", "last-ver", 2);
    // The last one removes it, and a synced datastore must hear of it.
    assertEquals(calls.includes(latest), true);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("collectGarbage: emits per-path markDirty for each removed version", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
    );

    const gcData = Data.create({
      name: "gc-dirty",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 2,
      streaming: false,
      tags: { type: "resource" },
      ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    });

    for (let i = 0; i < 4; i++) {
      await repo.save(
        testType,
        "gc-model",
        gcData,
        new TextEncoder().encode(`v${i}`),
      );
    }

    calls.length = 0;

    const result = await repo.collectGarbage(testType, "gc-model");
    assertEquals(result.versionsRemoved, 2);

    const v1Dir = repo.getPath(testType, "gc-model", "gc-dirty", 1);
    const v2Dir = repo.getPath(testType, "gc-model", "gc-dirty", 2);
    const pruneCalls = calls.filter((c) => c === v1Dir || c === v2Dir);
    // Each removal is marked before and after (swamp-club#2421).
    assertEquals(pruneCalls.length, 4);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("markDirty is not called on read paths", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: string[] = [];
    const markDirty = () => {
      calls.push("markDirty");
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
    );

    // Seed data with a write (a mark before it and one after).
    const data = makeData("read-probe");
    await repo.save(
      testType,
      "model-1",
      data,
      new TextEncoder().encode("x"),
    );
    assertEquals(calls.length, 2);

    // All reads below must not increment the count.
    await repo.findAllGlobal();
    await repo.findByName(testType, "model-1", "read-probe");
    await repo.findAllForModel(testType, "model-1");
    await repo.listVersions(testType, "model-1", "read-probe");
    await repo.getContent(testType, "model-1", "read-probe");
    repo.findAllForModelSync(testType, "model-1");
    repo.findByNameSync(testType, "model-1", "read-probe");
    repo.getContentSync(testType, "model-1", "read-probe");
    assertEquals(calls.length, 2);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// ============================================================================
// findAllGlobalSince — mirrors the workflow-run repo tests so the three
// implementations of the same two-stage filter stay in lockstep.
// ============================================================================

async function withDataRepo(
  fn: (
    repo: FileSystemUnifiedDataRepository,
    tmpDir: string,
  ) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    await fn(repo, tmpDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
}

Deno.test("findAllGlobalSince: returns only in-window data items", async () => {
  await withDataRepo(async (repo) => {
    const old = makeData("old-data");
    await repo.save(testType, "model-1", old, new TextEncoder().encode("x"));

    const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oldMetadataPath = repo.getMetadataPath(
      testType,
      "model-1",
      "old-data",
      1,
    );
    await Deno.utime(oldMetadataPath, oldDate, oldDate);

    const fresh = makeData("fresh-data");
    await repo.save(testType, "model-1", fresh, new TextEncoder().encode("y"));

    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const found = await repo.findAllGlobalSince(cutoff);

    assertEquals(found.length, 1);
    assertEquals(found[0].data.name, "fresh-data");
  });
});

Deno.test(
  "findAllGlobalSince: file deleted mid-iteration is skipped, not fatal",
  async () => {
    await withDataRepo(async (repo) => {
      const keep = makeData("keep-data");
      await repo.save(testType, "model-1", keep, new TextEncoder().encode("x"));

      const doomed = makeData("doomed-data");
      await repo.save(
        testType,
        "model-1",
        doomed,
        new TextEncoder().encode("y"),
      );

      // Concurrent deletion of the doomed item's metadata file. The data
      // repo already wraps stat in per-file try/catch; this test pins
      // that behavior so future refactors don't lose it.
      await Deno.remove(
        repo.getMetadataPath(testType, "model-1", "doomed-data", 1),
      );

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);

      assertEquals(found.length, 1);
      assertEquals(found[0].data.name, "keep-data");
    });
  },
);

Deno.test("getContent: accepts string type parameter", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("string-type-content");
    const content = new TextEncoder().encode("hello");
    await repo.save(testType, "model-1", data, content);

    const result = await repo.getContent(
      "test/model",
      "model-1",
      "string-type-content",
    );
    assertExists(result);
    assertEquals(new TextDecoder().decode(result), "hello");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findByName: accepts string type parameter", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("string-type-find");
    const content = new TextEncoder().encode("data");
    await repo.save(testType, "model-1", data, content);

    const result = await repo.findByName(
      "test/model",
      "model-1",
      "string-type-find",
    );
    assertExists(result);
    assertEquals(result.name, "string-type-find");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findAllForModel: accepts string type parameter", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("string-type-all");
    const content = new TextEncoder().encode("data");
    await repo.save(testType, "model-1", data, content);

    const results = await repo.findAllForModel("test/model", "model-1");
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "string-type-all");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getContent: calls hydrateFile hook when raw file is missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const expectedContent = new TextEncoder().encode("hydrated-content");

    const hydrateFile = async (absPath: string): Promise<boolean> => {
      // Hook receives absolute path (same pattern as MarkDirtyHook)
      await Deno.mkdir(join(absPath, ".."), { recursive: true });
      await Deno.writeFile(absPath, expectedContent);
      return true;
    };

    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      undefined,
      hydrateFile,
    );

    // Create a data item with content, then delete the raw file to simulate
    // lazy hydration state (metadata exists but raw is missing)
    const data = makeData("hydrate-test");
    await repo.save(testType, "model-1", data, expectedContent);
    const contentPath = repo.getContentPath(
      testType,
      "model-1",
      "hydrate-test",
      1,
    );
    await Deno.remove(contentPath);

    // getContent should call hydrateFile and return the content
    const result = await repo.getContent(
      testType,
      "model-1",
      "hydrate-test",
      1,
    );
    assertExists(result);
    assertEquals(new TextDecoder().decode(result), "hydrated-content");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getContent: returns null when hydrateFile returns false", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));

    const hydrateFile = (_absPath: string): Promise<boolean> => {
      return Promise.resolve(false);
    };

    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      undefined,
      hydrateFile,
    );

    // Create a data item then delete the raw file
    const data = makeData("hydrate-fail");
    const content = new TextEncoder().encode("temp");
    await repo.save(testType, "model-1", data, content);
    const contentPath = repo.getContentPath(
      testType,
      "model-1",
      "hydrate-fail",
      1,
    );
    await Deno.remove(contentPath);

    // getContent should return null since hydrateFile returned false
    const result = await repo.getContent(
      testType,
      "model-1",
      "hydrate-fail",
      1,
    );
    assertEquals(result, null);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getContent: returns null without hook when raw file is missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );

    // Create a data item then delete the raw file
    const data = makeData("no-hook");
    const content = new TextEncoder().encode("temp");
    await repo.save(testType, "model-1", data, content);
    const contentPath = repo.getContentPath(testType, "model-1", "no-hook", 1);
    await Deno.remove(contentPath);

    // Without hydrateFile hook, getContent returns null
    const result = await repo.getContent(testType, "model-1", "no-hook", 1);
    assertEquals(result, null);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

/**
 * A repository whose unreadable-content lookup answers `answer` and records
 * the paths it was asked about (swamp-club#3617).
 */
async function withUnreadableLookup(
  answer: UserError | undefined,
  fn: (
    repo: FileSystemUnifiedDataRepository,
    asked: string[],
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  const catalogStore = new CatalogStore(join(dir, "_catalog.db"));
  const asked: string[] = [];
  try {
    await fn(
      new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        catalogStore,
        undefined,
        undefined,
        SOLO_NAMESPACE,
        false,
        undefined,
        undefined,
        (absPath) => {
          asked.push(absPath);
          return Promise.resolve(answer);
        },
      ),
      asked,
    );
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("getContent: throws the error the unreadable-content lookup returns for missing content", async () => {
  const unreadable = new UserError(
    "unreadable",
    "datastore_v3_record_unreadable",
  );
  await withUnreadableLookup(unreadable, async (repo, asked) => {
    await repo.save(testType, "model-1", makeData("lost"), new Uint8Array([1]));
    const contentPath = repo.getContentPath(testType, "model-1", "lost", 1);
    await Deno.remove(contentPath);

    const error = await assertRejects(() =>
      repo.getContent(testType, "model-1", "lost", 1)
    );
    assert(error === unreadable);
    assertEquals(asked, [contentPath]);
  });
});

Deno.test("stream: throws the error the unreadable-content lookup returns for missing content", async () => {
  const unreadable = new UserError(
    "unreadable",
    "datastore_v3_record_unreadable",
  );
  await withUnreadableLookup(unreadable, async (repo, asked) => {
    await repo.save(testType, "model-1", makeData("lost"), new Uint8Array([1]));
    const contentPath = repo.getContentPath(testType, "model-1", "lost", 1);
    await Deno.remove(contentPath);

    const error = await assertRejects(async () => {
      for await (const _ of repo.stream(testType, "model-1", "lost", 1)) {
        // drain
      }
    });
    assert(error === unreadable);
    assertEquals(asked, [contentPath]);
  });
});

Deno.test("ensureContentLocal: throws the error the unreadable-content lookup returns for missing content", async () => {
  const unreadable = new UserError(
    "unreadable",
    "datastore_v3_record_unreadable",
  );
  await withUnreadableLookup(unreadable, async (repo, asked) => {
    await repo.save(testType, "model-1", makeData("lost"), new Uint8Array([1]));
    const contentPath = repo.getContentPath(testType, "model-1", "lost", 1);
    await Deno.remove(contentPath);

    // The synchronous readers ensure content first, so this is where they
    // fail loudly; the latest version is found when none is given.
    for (const version of [1, undefined]) {
      const error = await assertRejects(() =>
        repo.ensureContentLocal(testType, "model-1", "lost", version)
      );
      assert(error === unreadable);
    }
    assertEquals(asked, [contentPath, contentPath]);
  });
});

Deno.test("ensureContentLocal: without a hydrate hook, present content never asks the lookup and unknown missing content stays current", async () => {
  const unreadable = new UserError(
    "unreadable",
    "datastore_v3_record_unreadable",
  );
  await withUnreadableLookup(unreadable, async (repo, asked) => {
    await repo.save(testType, "model-1", makeData("here"), new Uint8Array([7]));
    assertEquals(
      await repo.ensureContentLocal(testType, "model-1", "here", 1),
      "current",
    );
    assertEquals(
      await repo.ensureContentLocal(testType, "model-1", "never-written"),
      "current",
    );
    assertEquals(asked, []);
  });
  await withUnreadableLookup(undefined, async (repo, asked) => {
    await repo.save(testType, "model-1", makeData("gone"), new Uint8Array([1]));
    const contentPath = repo.getContentPath(testType, "model-1", "gone", 1);
    await Deno.remove(contentPath);
    assertEquals(
      await repo.ensureContentLocal(testType, "model-1", "gone", 1),
      "current",
    );
    assertEquals(asked, [contentPath]);
  });
});

Deno.test("getContent and stream: missing content the lookup does not know reads as absent", async () => {
  await withUnreadableLookup(undefined, async (repo, asked) => {
    await repo.save(testType, "model-1", makeData("gone"), new Uint8Array([1]));
    await Deno.remove(repo.getContentPath(testType, "model-1", "gone", 1));

    assertEquals(await repo.getContent(testType, "model-1", "gone", 1), null);
    const chunks: Uint8Array[] = [];
    for await (const chunk of repo.stream(testType, "model-1", "gone", 1)) {
      chunks.push(chunk);
    }
    assertEquals(chunks, []);
    assertEquals(asked.length, 2);
  });
});

Deno.test("getContent and stream: present content never asks the unreadable-content lookup", async () => {
  const unreadable = new UserError(
    "unreadable",
    "datastore_v3_record_unreadable",
  );
  await withUnreadableLookup(unreadable, async (repo, asked) => {
    await repo.save(testType, "model-1", makeData("here"), new Uint8Array([7]));

    assertEquals(
      await repo.getContent(testType, "model-1", "here", 1),
      new Uint8Array([7]),
    );
    for await (const _ of repo.stream(testType, "model-1", "here", 1)) {
      // drain
    }
    assertEquals(asked, []);
  });
});

Deno.test("save: does not prune versions without enableWriteGc", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );

    const data = Data.create({
      name: "no-prune",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 3,
      streaming: false,
      tags: { type: "resource" },
      ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    });

    for (let i = 0; i < 8; i++) {
      await repo.save(
        testType,
        "prune-model",
        data,
        new TextEncoder().encode(`v${i}`),
      );
    }

    const versions = await repo.listVersions(
      testType,
      "prune-model",
      "no-prune",
    );
    assertEquals(versions.length, 8);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("save: prunes versions at write time with enableWriteGc", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      undefined,
      undefined,
      SOLO_NAMESPACE,
      true,
    );

    const data = Data.create({
      name: "capped",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 3,
      streaming: false,
      tags: { type: "resource" },
      ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    });

    for (let i = 0; i < 8; i++) {
      await repo.save(
        testType,
        "prune-model",
        data,
        new TextEncoder().encode(`v${i}`),
      );
    }

    const versions = await repo.listVersions(testType, "prune-model", "capped");
    assertEquals(versions.length, 3);
    assertEquals(versions, [6, 7, 8]);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("save: write-time pruning emits markDirty for each pruned version", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
      undefined,
      SOLO_NAMESPACE,
      true,
    );

    const data = Data.create({
      name: "dirty-prune",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 2,
      streaming: false,
      tags: { type: "resource" },
      ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    });

    await repo.save(testType, "m", data, new TextEncoder().encode("a"));
    await repo.save(testType, "m", data, new TextEncoder().encode("b"));
    calls.length = 0;

    await repo.save(testType, "m", data, new TextEncoder().encode("c"));

    const v1Dir = repo.getPath(testType, "m", "dirty-prune", 1);
    const pruneMarkDirty = calls.filter((c) => c === v1Dir);
    // Before the removal and after it (swamp-club#2421).
    assertEquals(pruneMarkDirty.length, 2);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// ============================================================================
// Numeric data names — models that key resources by an external numeric id
// (TMDB id, issue number) produce `{model-id}/{207333}/{1}/`, which the tree
// walk must not confuse with `{model-id}/{data-name}/{version}/`.
// ============================================================================

Deno.test(
  "findAllGlobal: finds data whose names are purely numeric",
  async () => {
    await withDataRepo(async (repo) => {
      for (const name of ["207333", "124364", "289324"]) {
        await repo.save(
          testType,
          "model-1",
          makeData(name),
          new TextEncoder().encode("x"),
        );
      }

      const found = await repo.findAllGlobal();

      assertEquals(found.length, 3);
      assertEquals(
        found.map((f) => f.data.name).sort(),
        ["124364", "207333", "289324"],
      );
      // The type must survive the walk intact — deriving it from a truncated
      // path is what silently drops these records.
      for (const f of found) {
        assertEquals(f.modelType.normalized, testType.normalized);
        assertEquals(f.modelId, "model-1");
      }
    });
  },
);

Deno.test(
  "findAllGlobalSync: finds data whose names are purely numeric",
  async () => {
    await withDataRepo(async (repo) => {
      await repo.save(
        testType,
        "model-1",
        makeData("207333"),
        new TextEncoder().encode("x"),
      );

      const found = repo.findAllGlobalSync();

      assertEquals(found.length, 1);
      assertEquals(found[0].data.name, "207333");
      assertEquals(found[0].modelType.normalized, testType.normalized);
      assertEquals(found[0].modelId, "model-1");
    });
  },
);

Deno.test(
  "findAllGlobal: numeric and named data coexist under one model",
  async () => {
    await withDataRepo(async (repo) => {
      await repo.save(
        testType,
        "model-1",
        makeData("207333"),
        new TextEncoder().encode("x"),
      );
      await repo.save(
        testType,
        "model-1",
        makeData("recommendations"),
        new TextEncoder().encode("y"),
      );

      const found = await repo.findAllGlobal();

      assertEquals(
        found.map((f) => f.data.name).sort(),
        ["207333", "recommendations"],
      );
    });
  },
);

async function withRenameRepo(
  fn: (
    repo: FileSystemUnifiedDataRepository,
    catalogStore: CatalogStore,
    modelId: string,
  ) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    await fn(repo, catalogStore, crypto.randomUUID());
    catalogStore.close();
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
}

Deno.test("rename: records the rename forward in the catalog", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("old"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "old", "new");

    assertEquals(
      catalogStore.findRenameTarget(
        SOLO_NAMESPACE,
        testType.normalized,
        modelId,
        "old",
      ),
      "new",
    );
    assertEquals(
      [...catalogStore.iterate()].some((r) =>
        r.model_id === modelId && r.data_name === "old" && r.is_latest === 1
      ),
      false,
    );
  });
});

Deno.test("save: writing a renamed-away name again ends its forward", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("b"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "b", "c");
    await repo.save(testType, modelId, makeData("b"), new Uint8Array([2]));

    assertEquals(
      catalogStore.findRenameTarget(
        SOLO_NAMESPACE,
        testType.normalized,
        modelId,
        "b",
      ),
      null,
    );
    assertEquals((await repo.findByName(testType, modelId, "b"))?.name, "b");
  });
});

Deno.test("findAllGlobal: reports each rename marker it follows past", async () => {
  await withRenameRepo(async (repo, _catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("x"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "x", "y");
    await repo.rename(testType, modelId, "y", "z");
    await repo.save(testType, modelId, makeData("plain"), new Uint8Array([2]));

    for (const sync of [false, true]) {
      const renames: RenameForward[] = [];
      const all = sync
        ? repo.findAllGlobalSync({ renames })
        : await repo.findAllGlobal({ renames });
      assertEquals(all.map((d) => d.data.name).sort(), ["plain", "z"]);
      assertEquals(
        renames.map((r) => [r.modelId, r.dataName, r.renamedTo]).sort(),
        [[modelId, "x", "y"], [modelId, "y", "z"]],
      );
    }
  });
});

Deno.test("rename: a failed forward write leaves the rename in place", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("old"), new Uint8Array([1]));
    catalogStore.recordRename = () => {
      throw new Error("database is locked");
    };

    const result = await repo.rename(testType, modelId, "old", "new");

    assertEquals(result.newName, "new");
    assertEquals(
      (await repo.findByName(testType, modelId, "old"))?.name,
      "new",
    );
    assertEquals(
      new TextDecoder().decode(
        (await repo.getContent(testType, modelId, "new"))!,
      ),
      "\x01",
    );
  });
});

Deno.test("delete: deleting a renamed name ends its forward", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("old"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "old", "new");
    await repo.delete(testType, modelId, "old");

    assertEquals(
      catalogStore.findRenameTarget(
        SOLO_NAMESPACE,
        testType.normalized,
        modelId,
        "old",
      ),
      null,
    );
    assertEquals(await repo.findByName(testType, modelId, "old"), null);
  });
});

Deno.test("delete: deleting an old version keeps the forward of a rename marker that stays latest", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("old"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "old", "new");
    await repo.delete(testType, modelId, "old", 1);

    assertEquals(
      (await repo.findByName(testType, modelId, "old"))?.name,
      "new",
    );
    assertEquals(
      catalogStore.findRenameTarget(
        SOLO_NAMESPACE,
        testType.normalized,
        modelId,
        "old",
      ),
      "new",
    );
    assertEquals(
      [...catalogStore.iterate()].some((r) =>
        r.model_id === modelId && r.data_name === "old" && r.is_latest === 1
      ),
      false,
      "the tombstone is not a catalog row",
    );
  });
});

Deno.test("removeLatestMarker: an expired renamed name ends its forward", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("old"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "old", "new");
    await repo.removeLatestMarker(testType, modelId, "old");

    assertEquals(
      catalogStore.findRenameTarget(
        SOLO_NAMESPACE,
        testType.normalized,
        modelId,
        "old",
      ),
      null,
    );
  });
});

Deno.test("delete: deleting an old version of an item with a deletion marker keeps its history rows", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    const data = makeData("r");
    await repo.save(testType, modelId, data, new Uint8Array([1]));
    await repo.save(testType, modelId, data, new Uint8Array([2]));
    const v2 = await repo.findByName(testType, modelId, "r");
    await repo.save(
      testType,
      modelId,
      v2!.withDeletionMarker({ version: v2!.version + 1 }),
      new TextEncoder().encode("{}"),
    );

    await repo.delete(testType, modelId, "r", 1);

    const versions = [...catalogStore.iterate()]
      .filter((r) => r.model_id === modelId && r.data_name === "r")
      .map((r) => r.version)
      .sort();
    assertEquals(versions, [2, 3]);
  });
});

Deno.test("sortedSubdirectoryNames: keeps only directories, in code-unit order", () => {
  const entries = [
    { name: "b", isDirectory: true },
    { name: "latest", isDirectory: false },
    { name: "a", isDirectory: true },
    { name: "Z", isDirectory: true },
    { name: "c", isDirectory: true },
  ];
  assertEquals(sortedSubdirectoryNames(entries), ["Z", "a", "b", "c"]);
});

/** Saves one JSON item per name under `modelId`, in the order given. */
async function saveNamed(
  repo: FileSystemUnifiedDataRepository,
  type: ModelType,
  modelId: string,
  names: string[],
): Promise<void> {
  for (const name of names) {
    await repo.save(
      type,
      modelId,
      makeJsonData(name),
      new TextEncoder().encode(`{"name":"${name}"}`),
    );
  }
}

Deno.test("findAllForModel: returns data in name order regardless of save order", async () => {
  await withTempRepo(async (repo) => {
    await saveNamed(repo, testType, "model-1", ["c", "a", "b"]);
    const names = (await repo.findAllForModel(testType, "model-1")).map((d) =>
      d.name
    );
    assertEquals(names, ["a", "b", "c"]);
    assertEquals(
      repo.findAllForModelSync(testType, "model-1").map((d) => d.name),
      ["a", "b", "c"],
    );
  });
});

Deno.test("findAllGlobal: walks types, model ids and data names in name order", async () => {
  await withTempRepo(async (repo) => {
    const otherType = ModelType.create("other/type");
    await saveNamed(repo, testType, "model-b", ["y", "x"]);
    await saveNamed(repo, otherType, "model-c", ["q"]);
    await saveNamed(repo, testType, "model-a", ["n", "m"]);
    const expected = [
      "other/type model-c q",
      "test/model model-a m",
      "test/model model-a n",
      "test/model model-b x",
      "test/model model-b y",
    ];
    const key = (
      r: { data: { name: string }; modelType: ModelType; modelId: string },
    ) => `${r.modelType.normalized} ${r.modelId} ${r.data.name}`;
    assertEquals((await repo.findAllGlobal()).map(key), expected);
    assertEquals(repo.findAllGlobalSync().map(key), expected);
    assertEquals(
      (await repo.findAllForType(testType)).map(key),
      expected.slice(1),
    );
  });
});

// --- Removing a version keeps every step's latest (swamp-club#2975) ---

function stepData(stepName: string, garbageCollection = 100): Data {
  return Data.create({
    name: "out",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "workflow-step",
      ownerRef: "test/model:run",
      stepName,
    },
  });
}

/** `version:is_latest:is_step_latest` for every catalog row of `out`. */
function outFlags(catalogStore: CatalogStore): string[] {
  return [...catalogStore.iterate()]
    .filter((r) => r.data_name === "out")
    .sort((a, b) => a.version - b.version)
    .map((r) => `${r.version}:${r.is_latest}:${r.is_step_latest}`);
}

/** The flags a full catalog rebuild derives for the promoted rows of `out`. */
function rebuiltOutFlags(catalogStore: CatalogStore): string[] {
  const rows = [...catalogStore.iterate()].filter((r) =>
    r.data_name === "out" && r.is_pending === 0
  );
  computeLatestFlags(rows);
  return rows
    .sort((a, b) => a.version - b.version)
    .map((r) => `${r.version}:${r.is_latest}:${r.is_step_latest}`);
}

async function withStepRepo(
  fn: (
    repo: FileSystemUnifiedDataRepository,
    catalogStore: CatalogStore,
  ) => Promise<void>,
  enableWriteGc = false,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-step-latest-" });
  const catalogStore = new CatalogStore(join(dir, "_catalog.db"));
  try {
    await fn(
      new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        catalogStore,
        undefined,
        undefined,
        SOLO_NAMESPACE,
        enableWriteGc,
      ),
      catalogStore,
    );
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const bytes = (s: string) => new TextEncoder().encode(s);

Deno.test("delete: deleting a step's latest version makes its previous version that step's latest again (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    await repo.save(testType, "m1", stepData("s2"), bytes("b"));
    await repo.save(testType, "m1", stepData("s1"), bytes("c"));
    assertEquals(outFlags(catalogStore), ["1:0:0", "2:0:1", "3:1:1"]);

    await repo.delete(testType, "m1", "out", 3);

    assertEquals(outFlags(catalogStore), ["1:0:1", "2:1:1"]);
    assertEquals(outFlags(catalogStore), rebuiltOutFlags(catalogStore));
  });
});

Deno.test("rollbackVersions: rolling back a step's deferred write makes its promoted version that step's latest (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    // s1 reserves v1 and v2 as deferred writes; s2 then promotes v3.
    const first = await repo.saveDeferred(
      testType,
      "m1",
      stepData("s1"),
      bytes("a"),
    );
    const second = await repo.saveDeferred(
      testType,
      "m1",
      stepData("s1"),
      bytes("b"),
    );
    await repo.save(testType, "m1", stepData("s2"), bytes("c"));
    // v1 promotes while v2 is still in flight, so v2 outranks it in s1.
    await repo.advanceLatestMarkers([first]);
    assertEquals(outFlags(catalogStore), ["1:0:0", "2:0:0", "3:1:1"]);

    await repo.rollbackVersions([second]);

    assertEquals(outFlags(catalogStore), ["1:0:1", "3:1:1"]);
    assertEquals(outFlags(catalogStore), rebuiltOutFlags(catalogStore));
  });
});

Deno.test("rollbackVersions: rolling back one deferred write leaves another in-flight one unpromoted (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    const rolledBack = await repo.saveDeferred(
      testType,
      "m1",
      stepData("s2"),
      bytes("b"),
    );
    await repo.saveDeferred(testType, "m1", stepData("s1"), bytes("c"));

    await repo.rollbackVersions([rolledBack]);

    assertEquals(outFlags(catalogStore), ["1:1:1", "3:0:0"]);
    const inFlight = [...catalogStore.iterate()].find((r) => r.version === 3);
    assertEquals(inFlight?.is_pending, 1);
  });
});

Deno.test("collectGarbage: every step keeps a step latest after pruning old versions (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1", 3), bytes("a"));
    await repo.save(testType, "m1", stepData("s2", 3), bytes("b"));
    await repo.save(testType, "m1", stepData("s1", 3), bytes("c"));
    await repo.save(testType, "m1", stepData("s1", 3), bytes("d"));

    const result = await repo.collectGarbage(testType, "m1");
    assertEquals(result.versionsRemoved, 1);

    assertEquals(outFlags(catalogStore), ["2:0:1", "3:0:0", "4:1:1"]);
    assertEquals(outFlags(catalogStore), rebuiltOutFlags(catalogStore));
  });
});

Deno.test("save: every step keeps a step latest after the write-time version cap prunes (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1", 3), bytes("a"));
    await repo.save(testType, "m1", stepData("s2", 3), bytes("b"));
    await repo.save(testType, "m1", stepData("s1", 3), bytes("c"));
    await repo.save(testType, "m1", stepData("s1", 3), bytes("d"));

    assertEquals(await repo.listVersions(testType, "m1", "out"), [2, 3, 4]);
    assertEquals(outFlags(catalogStore), ["2:0:1", "3:0:0", "4:1:1"]);
    assertEquals(outFlags(catalogStore), rebuiltOutFlags(catalogStore));
  }, true);
});

Deno.test("delete: deleting a version leaves an in-flight deferred write unpromoted (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    await repo.save(testType, "m1", stepData("s2"), bytes("b"));
    await repo.saveDeferred(testType, "m1", stepData("s1"), bytes("c"));

    await repo.delete(testType, "m1", "out", 2);

    assertEquals(outFlags(catalogStore), ["1:1:1", "3:0:0"]);
    const inFlight = [...catalogStore.iterate()].find((r) => r.version === 3);
    assertEquals(inFlight?.is_pending, 1);
    assertEquals((await repo.findByName(testType, "m1", "out"))?.version, 1);
  });
});

Deno.test("delete: deleting the only promoted version keeps an in-flight deferred write, which promotes later (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    const inFlight = await repo.saveDeferred(
      testType,
      "m1",
      stepData("s1"),
      bytes("b"),
    );

    await repo.delete(testType, "m1", "out", 1);

    // The directory and the in-flight write stay, but neither the catalog
    // nor a disk read sees the write until its own promotion.
    assertEquals(await repo.listVersions(testType, "m1", "out"), [2]);
    assertEquals(outFlags(catalogStore), ["2:0:0"]);
    assertEquals(await repo.findByName(testType, "m1", "out"), null);
    assertEquals(repo.findByNameSync(testType, "m1", "out"), null);

    await repo.advanceLatestMarkers([inFlight]);

    assertEquals((await repo.findByName(testType, "m1", "out"))?.version, 2);
    assertEquals(outFlags(catalogStore), ["2:1:1"]);
  });
});

Deno.test("collectGarbage: counts, keeps and prunes only promoted versions, never an in-flight deferred write (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1", 1), bytes("a"));
    await repo.save(testType, "m1", stepData("s1", 1), bytes("b"));
    await repo.saveDeferred(testType, "m1", stepData("s1", 1), bytes("c"));

    const result = await repo.collectGarbage(testType, "m1");

    assertEquals(result.versionsRemoved, 1);
    assertEquals(await repo.listVersions(testType, "m1", "out"), [2, 3]);
    assertEquals(outFlags(catalogStore), ["2:1:1", "3:0:0"]);
    assertEquals((await repo.findByName(testType, "m1", "out"))?.version, 2);
  });
});

Deno.test("save: the write-time version cap neither counts nor prunes an in-flight deferred write (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.saveDeferred(testType, "m1", stepData("s1", 2), bytes("a"));
    await repo.save(testType, "m1", stepData("s1", 2), bytes("b"));
    await repo.save(testType, "m1", stepData("s1", 2), bytes("c"));

    assertEquals(await repo.listVersions(testType, "m1", "out"), [1, 2, 3]);
    assertEquals(outFlags(catalogStore), ["1:0:0", "2:0:0", "3:1:1"]);
  }, true);
});

/** A pid no process can hold, so isProcessGone reports it gone. */
const DEAD_PID = 2147483647;

/** Rewrites the writer identity of a pending catalog row. */
function setPendingWriter(
  catalogStore: CatalogStore,
  modelId: string,
  version: number,
  pid: number,
  host = processHostIdentity(),
): void {
  const row = [...catalogStore.iterate()].find((r) =>
    r.model_id === modelId && r.version === version
  );
  assertExists(row);
  assertEquals(row.is_pending, 1);
  catalogStore.upsert({ ...row, pending_pid: pid, pending_host: host });
}

Deno.test("collectGarbage: rolls back a deferred write whose process died (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    await repo.saveDeferred(testType, "m1", stepData("s1"), bytes("b"));
    setPendingWriter(catalogStore, "m1", 2, DEAD_PID);

    const result = await repo.collectGarbage(testType, "m1");

    assertEquals(result.versionsRemoved, 1);
    assertEquals(await repo.listVersions(testType, "m1", "out"), [1]);
    assertEquals(outFlags(catalogStore), ["1:1:1"]);
  });
});

Deno.test("collectGarbage: leaves a deferred write from a live process, this process, another host or another container in flight (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    for (const modelId of ["live", "self", "remote", "container"]) {
      await repo.save(testType, modelId, stepData("s1"), bytes("a"));
      await repo.saveDeferred(testType, modelId, stepData("s1"), bytes("b"));
    }
    const self = [...catalogStore.iterate()].find((r) =>
      r.model_id === "self" && r.version === 2
    );
    assertEquals([self?.pending_pid, self?.pending_host], [
      Deno.pid,
      processHostIdentity(),
    ]);
    setPendingWriter(catalogStore, "live", 2, Deno.ppid);
    setPendingWriter(catalogStore, "remote", 2, DEAD_PID, "another-host");
    // Same hostname, another pid namespace: host networking in a container.
    setPendingWriter(
      catalogStore,
      "container",
      2,
      DEAD_PID,
      `${hostname()}#pid:[1]`,
    );

    for (const modelId of ["live", "self", "remote", "container"]) {
      const result = await repo.collectGarbage(testType, modelId);
      assertEquals(result.versionsRemoved, 0, modelId);
      assertEquals(
        await repo.listVersions(testType, modelId, "out"),
        [1, 2],
        modelId,
      );
    }
  });
});

Deno.test("collectGarbage: a dry run does not roll back a deferred write whose process died (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    await repo.saveDeferred(testType, "m1", stepData("s1"), bytes("b"));
    setPendingWriter(catalogStore, "m1", 2, DEAD_PID);

    await repo.collectGarbage(testType, "m1", { dryRun: true });

    assertEquals(await repo.listVersions(testType, "m1", "out"), [1, 2]);
  });
});

Deno.test("collectGarbage: removes a data name whose only version left was a deferred write whose process died (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    await repo.saveDeferred(testType, "m1", stepData("s1"), bytes("b"));
    await repo.delete(testType, "m1", "out", 1);
    setPendingWriter(catalogStore, "m1", 2, DEAD_PID);

    const result = await repo.collectGarbage(testType, "m1");

    assertEquals(result.versionsRemoved, 1);
    assertEquals(await repo.listVersions(testType, "m1", "out"), []);
    assertEquals(outFlags(catalogStore), []);
    assertEquals(await repo.findByName(testType, "m1", "out"), null);
  });
});

Deno.test("allocateVersion: a deferred allocation is pending before its content is written (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    const { version } = await repo.allocateVersion(
      testType,
      "m1",
      stepData("s1"),
      { deferred: true },
    );

    const row = [...catalogStore.iterate()].find((r) => r.version === version);
    assertEquals(
      [row?.is_latest, row?.is_step_latest, row?.is_pending, row?.pending_pid],
      [0, 0, 1, Deno.pid],
    );
  });
});

Deno.test("delete: a streamed deferred write allocated before the delete is not made readable by it (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    const data = stepData("s1");
    await repo.save(testType, "m1", data, bytes("a"));
    const { version, contentPath, priorVersions } = await repo.allocateVersion(
      testType,
      "m1",
      data,
      { deferred: true },
    );

    await repo.delete(testType, "m1", "out", 1);
    await Deno.writeFile(contentPath, bytes("b"));
    const { receipt } = await repo.finalizeVersionDeferred(
      testType,
      "m1",
      data,
      version,
      priorVersions,
    );

    assertEquals(await repo.findByName(testType, "m1", "out"), null);
    assertEquals(outFlags(catalogStore), ["2:0:0"]);

    await repo.advanceLatestMarkers([receipt]);
    assertEquals((await repo.findByName(testType, "m1", "out"))?.version, 2);
  });
});

Deno.test("rollbackVersions: rolling back the only write left after its promoted versions were deleted removes the name (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    const inFlight = await repo.saveDeferred(
      testType,
      "m1",
      stepData("s1"),
      bytes("b"),
    );
    await repo.delete(testType, "m1", "out", 1);

    await repo.rollbackVersions([inFlight]);

    const dataNameDir = dirname(repo.getPath(testType, "m1", "out", 1));
    assertEquals(
      await Deno.stat(dataNameDir).then(() => true, () => false),
      false,
    );
    assertEquals(outFlags(catalogStore), []);
  });
});

Deno.test("rollbackVersions: rolling back a first deferred write leaves its data name directory as before (swamp-club#2975)", async () => {
  await withStepRepo(async (repo) => {
    const inFlight = await repo.saveDeferred(
      testType,
      "m1",
      stepData("s1"),
      bytes("a"),
    );

    await repo.rollbackVersions([inFlight]);

    const dataNameDir = dirname(repo.getPath(testType, "m1", "out", 1));
    assertEquals(
      await Deno.stat(dataNameDir).then(() => true, () => false),
      true,
    );
    assertEquals(await repo.listVersions(testType, "m1", "out"), []);
  });
});

Deno.test("collectGarbage: settles rather than reclaims a pending version the latest marker names (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    await repo.saveDeferred(testType, "m1", stepData("s1"), bytes("b"));
    setPendingWriter(catalogStore, "m1", 2, DEAD_PID);
    // A promotion that moved the marker before its process died.
    await Deno.writeTextFile(
      join(dirname(repo.getPath(testType, "m1", "out", 2)), "latest"),
      "2",
    );

    const result = await repo.collectGarbage(testType, "m1");

    assertEquals(result.versionsRemoved, 0);
    assertEquals(await repo.listVersions(testType, "m1", "out"), [1, 2]);
    assertEquals(outFlags(catalogStore), ["1:0:0", "2:1:1"]);
    const settled = [...catalogStore.iterate()].find((r) => r.version === 2);
    assertEquals(settled?.is_pending, 0);
  });
});

Deno.test("advanceLatestMarkers: settles the pending row before promoting, and drops it for a version that was never finalized (swamp-club#2975)", async () => {
  await withStepRepo(async (repo, catalogStore) => {
    const finished = await repo.saveDeferred(
      testType,
      "m1",
      stepData("s1"),
      bytes("a"),
    );
    const unfinished = await repo.allocateVersion(
      testType,
      "m2",
      stepData("s1"),
      { deferred: true },
    );

    await repo.advanceLatestMarkers([
      finished,
      {
        type: testType,
        modelId: "m2",
        dataName: "out",
        version: unfinished.version,
      },
    ]);

    const rows = [...catalogStore.iterate()];
    const m1 = rows.find((r) => r.model_id === "m1");
    assertEquals(
      [m1?.is_latest, m1?.is_pending, m1?.pending_pid, m1?.pending_host],
      [1, 0, 0, ""],
    );
    assertEquals(rows.filter((r) => r.model_id === "m2"), []);
  });
});

/** Fails the metadata write of one version, as a full disk would. */
class FailingMetadataRepository extends FileSystemUnifiedDataRepository {
  failVersion: number | null = null;

  override getMetadataPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    if (version === this.failVersion) {
      throw new Error("No space left on device");
    }
    return super.getMetadataPath(type, modelId, dataName, version);
  }
}

Deno.test("saveDeferred: a failed write removes its version and pending row (swamp-club#2975)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-step-latest-" });
  const catalogStore = new CatalogStore(join(dir, "_catalog.db"));
  try {
    const repo = new FailingMetadataRepository(dir, undefined, catalogStore);
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    repo.failVersion = 2;

    await assertRejects(
      () => repo.saveDeferred(testType, "m1", stepData("s1"), bytes("b")),
      Error,
      "No space left on device",
    );

    assertEquals(await repo.listVersions(testType, "m1", "out"), [1]);
    assertEquals(outFlags(catalogStore), ["1:1:1"]);
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

/** Fails writing a pending row, as a locked catalog would. */
class FailingPendingCatalog extends CatalogStore {
  failPending = false;

  override upsert(row: CatalogRow): void {
    if (this.failPending && row.is_pending === 1) {
      throw new Error("database is locked");
    }
    super.upsert(row);
  }
}

Deno.test("saveDeferred: a failed pending-row write removes the allocated version (swamp-club#2975)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-step-latest-" });
  const catalogStore = new FailingPendingCatalog(join(dir, "_catalog.db"));
  try {
    const repo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalogStore,
    );
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    catalogStore.failPending = true;

    await assertRejects(
      () => repo.saveDeferred(testType, "m1", stepData("s1"), bytes("b")),
      Error,
      "database is locked",
    );

    assertEquals(await repo.listVersions(testType, "m1", "out"), [1]);
    assertEquals(outFlags(catalogStore), ["1:1:1"]);
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("saveDeferred: a write that reuses a deleted version number is not readable through the latest marker (swamp-club#2975)", async () => {
  await withStepRepo(async (repo) => {
    await repo.saveDeferred(testType, "m1", stepData("s1"), bytes("a"));
    await repo.save(testType, "m1", stepData("s1"), bytes("b"));
    // Only the in-flight v1 is left once v2 is deleted.
    await repo.delete(testType, "m1", "out", 2);

    const next = await repo.saveDeferred(
      testType,
      "m1",
      stepData("s1"),
      bytes("c"),
    );

    assertEquals(next.version, 2);
    assertEquals(await repo.findByName(testType, "m1", "out"), null);
    assertEquals(repo.findByNameSync(testType, "m1", "out"), null);
  });
});

Deno.test("allocateVersion: a failed pending-row write removes the allocated version (swamp-club#2975)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-step-latest-" });
  const catalogStore = new FailingPendingCatalog(join(dir, "_catalog.db"));
  try {
    const repo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalogStore,
    );
    await repo.save(testType, "m1", stepData("s1"), bytes("a"));
    catalogStore.failPending = true;

    await assertRejects(
      () =>
        repo.allocateVersion(testType, "m1", stepData("s1"), {
          deferred: true,
        }),
      Error,
      "database is locked",
    );

    assertEquals(await repo.listVersions(testType, "m1", "out"), [1]);
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

// --- Content-ensuring step (swamp-club#3178) ---

/**
 * A repository whose hydrate hook copies from `remote`, keyed by the
 * absolute content path, as a lazily hydrating datastore downloads the
 * remote's copy of a file.
 */
async function withLazyRepo(
  fn: (ctx: {
    repo: FileSystemUnifiedDataRepository;
    remote: Map<string, Uint8Array>;
    hydrations: string[];
    clock: { now: number };
    tmpDir: string;
    catalogStore: CatalogStore;
  }) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const remote = new Map<string, Uint8Array>();
    const hydrations: string[] = [];
    const clock = { now: 1_000_000 };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      undefined,
      async (absPath) => {
        hydrations.push(absPath);
        const bytes = remote.get(absPath);
        if (!bytes) return false;
        await Deno.mkdir(dirname(absPath), { recursive: true });
        await Deno.writeFile(absPath, bytes);
        return true;
      },
      SOLO_NAMESPACE,
      false,
      () => clock.now,
    );
    await fn({
      repo,
      remote,
      hydrations,
      clock,
      tmpDir,
      catalogStore,
    });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) =>
  b === null ? null : new TextDecoder().decode(b);

function makeStreamingData(name: string): Data {
  return Data.create({
    name,
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "test" },
    ownerDefinition: owner,
    streaming: true,
  });
}

/**
 * Saves `full` as version 1, publishes it as the remote's copy, then leaves
 * `local` in the cache: the state a metadata-only pull leaves after another
 * host appended to the version.
 */
async function seedStale(
  repo: FileSystemUnifiedDataRepository,
  remote: Map<string, Uint8Array>,
  name: string,
  full: string,
  local: string | null,
  data: Data = makeData(name),
): Promise<string> {
  await repo.save(testType, "model-1", data, enc(full));
  const contentPath = repo.getContentPath(testType, "model-1", name, 1);
  remote.set(contentPath, enc(full));
  if (local === null) await Deno.remove(contentPath);
  else await Deno.writeFile(contentPath, enc(local));
  return contentPath;
}

Deno.test("getContent: downloads again a content file shorter than its metadata records", async () => {
  await withLazyRepo(async ({ repo, remote, hydrations }) => {
    await seedStale(repo, remote, "stale", "line1\nline2\nline3\n", "line1\n");
    const result = await repo.getContent(testType, "model-1", "stale", 1);
    assertEquals(dec(result), "line1\nline2\nline3\n");
    assertEquals(hydrations.length, 1);
  });
});

Deno.test("stream: downloads a content file that is not local", async () => {
  await withLazyRepo(async ({ repo, remote }) => {
    await seedStale(repo, remote, "absent", "all of it", null);
    const chunks: Uint8Array[] = [];
    for await (const chunk of repo.stream(testType, "model-1", "absent", 1)) {
      chunks.push(chunk);
    }
    assertEquals(dec(concatBytes(chunks)), "all of it");
  });
});

Deno.test("stream: downloads again a content file shorter than its metadata records", async () => {
  await withLazyRepo(async ({ repo, remote }) => {
    await seedStale(repo, remote, "stale", "line1\nline2\n", "line1\n");
    const chunks: Uint8Array[] = [];
    for await (const chunk of repo.stream(testType, "model-1", "stale")) {
      chunks.push(chunk);
    }
    assertEquals(dec(concatBytes(chunks)), "line1\nline2\n");
  });
});

Deno.test("getContent: leaves a content file that is not shorter than its metadata alone", async () => {
  await withLazyRepo(async ({ repo, remote, hydrations }) => {
    await seedStale(repo, remote, "equal", "abcdef", "uvwxyz");
    await seedStale(repo, remote, "larger", "abc", "abcdef");
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "equal", 1)),
      "uvwxyz",
    );
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "larger", 1)),
      "abcdef",
    );
    assertEquals(hydrations, []);
  });
});

Deno.test("getContent: leaves a content file alone when its metadata records no size", async () => {
  await withLazyRepo(async ({ repo, remote, hydrations }) => {
    await seedStale(repo, remote, "nosize", "abcdef", "abc");
    const metadataPath = join(
      repo.getPath(testType, "model-1", "nosize", 1),
      "metadata.yaml",
    );
    const text = await Deno.readTextFile(metadataPath);
    await Deno.writeTextFile(
      metadataPath,
      text.split("\n").filter((l) => !l.startsWith("size:")).join("\n"),
    );
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "nosize", 1)),
      "abc",
    );
    assertEquals(hydrations, []);
  });
});

Deno.test("getContent: uses a copy the remote also holds short until the window passes", async () => {
  await withLazyRepo(async ({ repo, remote, hydrations, clock }) => {
    const path = await seedStale(repo, remote, "short", "abcdef", "abc");
    remote.set(path, enc("abcd"));
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "short", 1)),
      "abcd",
    );
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "short", 1)),
      "abcd",
    );
    assertEquals(hydrations.length, 1);

    // The remote's raw lands; a read after the window picks it up.
    remote.set(path, enc("abcdef"));
    clock.now += ACCEPTED_SHORT_CONTENT_TTL_MS - 1;
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "short", 1)),
      "abcd",
    );
    clock.now += 1;
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "short", 1)),
      "abcdef",
    );
    assertEquals(hydrations.length, 2);
  });
});

Deno.test("ensureContentLocal: reports current, acceptedShort and missing", async () => {
  await withLazyRepo(async ({ repo, remote }) => {
    await seedStale(repo, remote, "fresh", "abc", "abc");
    const shortPath = await seedStale(repo, remote, "short", "abcdef", "abc");
    remote.set(shortPath, enc("abcd"));
    const gonePath = await seedStale(repo, remote, "gone", "abc", null);
    remote.delete(gonePath);
    assertEquals(
      await repo.ensureContentLocal(testType, "model-1", "fresh"),
      "current",
    );
    assertEquals(
      await repo.ensureContentLocal(testType, "model-1", "short", 1, 6),
      "acceptedShort",
    );
    assertEquals(
      await repo.ensureContentLocal(testType, "model-1", "gone"),
      "missing",
    );
    assertEquals(
      await repo.ensureContentLocal(testType, "model-1", "never-written"),
      "missing",
    );
  });
});

Deno.test("ensureContentLocal: a repository without a hydrate hook reports current without looking", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      new CatalogStore(join(tmpDir, "_catalog.db")),
    );
    await repo.save(testType, "model-1", makeData("x"), enc("abcdef"));
    await Deno.writeFile(
      repo.getContentPath(testType, "model-1", "x", 1),
      enc("abc"),
    );
    assertEquals(
      await repo.ensureContentLocal(testType, "model-1", "x", 1),
      "current",
    );
    assertEquals(
      repo.isContentAcceptedSync(testType, "model-1", "x", 1, 6),
      true,
    );
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "x", 1)),
      "abc",
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("isContentAcceptedSync: accepts a short copy only while a refresh found the remote short too", async () => {
  await withLazyRepo(async ({ repo, remote, clock }) => {
    const path = await seedStale(repo, remote, "short", "abcdef", "abc");
    assertEquals(
      repo.isContentAcceptedSync(testType, "model-1", "short", 1, 6),
      false,
    );
    remote.set(path, enc("abcd"));
    await repo.getContent(testType, "model-1", "short", 1);
    assertEquals(
      repo.isContentAcceptedSync(testType, "model-1", "short", 1, 6),
      true,
    );
    assertEquals(
      repo.isContentAcceptedSync(testType, "model-1", "short", 1, 4),
      true,
    );
    clock.now += ACCEPTED_SHORT_CONTENT_TTL_MS;
    assertEquals(
      repo.isContentAcceptedSync(testType, "model-1", "short", 1, 6),
      false,
    );
    assertEquals(
      repo.isContentAcceptedSync(testType, "model-1", "absent", 1, 6),
      false,
    );
  });
});

Deno.test("isContentAcceptedSync: one repository's accepted copies are its own", async () => {
  await withLazyRepo(async ({ repo, remote, tmpDir, catalogStore }) => {
    const path = await seedStale(repo, remote, "short", "abcdef", "abc");
    remote.set(path, enc("abcd"));
    await repo.getContent(testType, "model-1", "short", 1);
    const other = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      undefined,
      () => Promise.resolve(false),
    );
    assertEquals(
      other.isContentAcceptedSync(testType, "model-1", "short", 1, 6),
      false,
    );
  });
});

Deno.test("append: downloads a stale content file before appending to it", async () => {
  await withLazyRepo(async ({ repo, remote }) => {
    await seedStale(
      repo,
      remote,
      "log",
      "line1\nline2\n",
      "line1\n",
      makeStreamingData("log"),
    );
    await repo.append(testType, "model-1", "log", enc("line3\n"));
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "log", 1)),
      "line1\nline2\nline3\n",
    );
    const data = await repo.findByName(testType, "model-1", "log", 1);
    assertEquals(data?.size, 18);
  });
});

Deno.test("append: refuses a content file the remote also holds short", async () => {
  await withLazyRepo(async ({ repo, remote }) => {
    const path = await seedStale(
      repo,
      remote,
      "log",
      "line1\nline2\n",
      "line1\n",
      makeStreamingData("log"),
    );
    remote.set(path, enc("line1\n"));
    // An earlier read accepts the short copy; append still refuses it.
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "log", 1)),
      "line1\n",
    );
    const error = await assertRejects(
      () => repo.append(testType, "model-1", "log", enc("line3\n")),
      Error,
    );
    assertStringIncludes(error.message, "push may not have finished");
    assertEquals(dec(await Deno.readFile(path)), "line1\n");
  });
});

Deno.test("append: refuses a content file that is neither local nor remote", async () => {
  await withLazyRepo(async ({ repo, remote }) => {
    const path = await seedStale(
      repo,
      remote,
      "log",
      "line1\n",
      null,
      makeStreamingData("log"),
    );
    remote.delete(path);
    await assertRejects(
      () => repo.append(testType, "model-1", "log", enc("line2\n")),
      Error,
      "could not be downloaded",
    );
  });
});

Deno.test("append: a repository without a hydrate hook appends as before", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      new CatalogStore(join(tmpDir, "_catalog.db")),
    );
    await repo.save(
      testType,
      "model-1",
      makeStreamingData("log"),
      enc("line1\n"),
    );
    await repo.append(testType, "model-1", "log", enc("line2\n"));
    assertEquals(
      dec(await repo.getContent(testType, "model-1", "log", 1)),
      "line1\nline2\n",
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function cappedData(cap: number): Data {
  return Data.create({
    name: "capped",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: cap,
    streaming: false,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test" },
  });
}

async function promoteDeferred(
  repo: FileSystemUnifiedDataRepository,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const receipt = await repo.saveDeferred(
      testType,
      "m1",
      cappedData(3),
      bytes(`v${i}`),
    );
    await repo.advanceLatestMarkers([receipt]);
  }
}

Deno.test("advanceLatestMarkers: prunes promoted deferred writes to the cap with enableWriteGc (swamp-club#3251)", async () => {
  await withStepRepo(async (repo) => {
    await promoteDeferred(repo, 6);

    assertEquals(await repo.listVersions(testType, "m1", "capped"), [4, 5, 6]);
    const latest = await repo.findByName(testType, "m1", "capped");
    assertEquals(latest?.version, 6);
  }, true);
});

Deno.test("advanceLatestMarkers: keeps every promoted deferred write without enableWriteGc (swamp-club#3251)", async () => {
  await withStepRepo(async (repo) => {
    await promoteDeferred(repo, 6);

    assertEquals(
      await repo.listVersions(testType, "m1", "capped"),
      [1, 2, 3, 4, 5, 6],
    );
  });
});

Deno.test("advanceLatestMarkers: pruning on promotion neither counts nor removes an in-flight deferred write (swamp-club#3251)", async () => {
  await withStepRepo(async (repo) => {
    await promoteDeferred(repo, 3);
    const inFlight = await repo.saveDeferred(
      testType,
      "m1",
      cappedData(3),
      bytes("in-flight"),
    );
    const promoted = await repo.saveDeferred(
      testType,
      "m1",
      cappedData(3),
      bytes("promoted"),
    );
    await repo.advanceLatestMarkers([promoted]);

    // v4 is still pending: v1 goes so v2, v3 and v5 make the cap of 3.
    assertEquals(await repo.listVersions(testType, "m1", "capped"), [
      2,
      3,
      inFlight.version,
      promoted.version,
    ]);
  }, true);
});

Deno.test("advanceLatestMarkers: promoting an older deferred write keeps the newest versions (swamp-club#3251)", async () => {
  await withStepRepo(async (repo) => {
    const older = await repo.saveDeferred(
      testType,
      "m1",
      cappedData(3),
      bytes("older"),
    );
    await promoteDeferred(repo, 3);
    await repo.advanceLatestMarkers([older]);

    // v1 is promoted last but is the oldest, so it is the one that goes.
    assertEquals(await repo.listVersions(testType, "m1", "capped"), [2, 3, 4]);
    const latest = await repo.findByName(testType, "m1", "capped");
    assertEquals(latest?.version, 4);
  }, true);
});

Deno.test("rollbackVersions: rolling back a deferred write prunes nothing with enableWriteGc (swamp-club#3251)", async () => {
  await withStepRepo(async (repo) => {
    await promoteDeferred(repo, 3);
    const rolledBack = await repo.saveDeferred(
      testType,
      "m1",
      cappedData(3),
      bytes("rolled back"),
    );
    await repo.rollbackVersions([rolledBack]);

    assertEquals(await repo.listVersions(testType, "m1", "capped"), [1, 2, 3]);
  }, true);
});

Deno.test("reassertLatestVersion: moves a reverted latest marker forward and stages the version and the marker (swamp-club#3146)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  const catalogStore = new CatalogStore(join(dir, "_catalog.db"));
  try {
    const marks: (string | undefined)[] = [];
    const repo = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalogStore,
      (path) => {
        marks.push(path);
        return Promise.resolve();
      },
    );
    await repo.save(testType, "model-1", makeData("state"), enc("one"));
    await repo.save(testType, "model-1", makeData("state"), enc("two"));
    const latestPath = join(
      repo.getDataNameDir(testType, "model-1", "state"),
      "latest",
    );
    // A pull of the datastore put back the remote's older marker.
    await Deno.writeTextFile(latestPath, "1");
    marks.length = 0;

    const paths = await repo.reassertLatestVersion(
      testType,
      "model-1",
      "state",
      2,
    );

    assertEquals(await Deno.readTextFile(latestPath), "2");
    const versionDir = repo.getPath(testType, "model-1", "state", 2);
    assertEquals(paths, { versionDir, latestPath });
    assertEquals(marks, [versionDir, latestPath]);
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("reassertLatestVersion: never lowers a marker naming a newer version", async () => {
  await withTempRepo(async (repo) => {
    await repo.save(testType, "model-1", makeData("state"), enc("one"));
    await repo.save(testType, "model-1", makeData("state"), enc("two"));

    const paths = await repo.reassertLatestVersion(
      testType,
      "model-1",
      "state",
      1,
    );

    assertExists(paths);
    assertEquals(
      await Deno.readTextFile(
        join(repo.getDataNameDir(testType, "model-1", "state"), "latest"),
      ),
      "2",
    );
  });
});

Deno.test("reassertLatestVersion: a version deleted on purpose changes nothing and returns undefined", async () => {
  await withTempRepo(async (repo) => {
    await repo.save(testType, "model-1", makeData("state"), enc("one"));
    await repo.save(testType, "model-1", makeData("state"), enc("two"));
    await repo.delete(testType, "model-1", "state", 2);
    const latestPath = join(
      repo.getDataNameDir(testType, "model-1", "state"),
      "latest",
    );
    const before = await Deno.readTextFile(latestPath);

    const paths = await repo.reassertLatestVersion(
      testType,
      "model-1",
      "state",
      2,
    );

    assertEquals(paths, undefined);
    assertEquals(await Deno.readTextFile(latestPath), before);
  });
});

Deno.test("allocateVersion: never allocates at or below a raised version floor (swamp-club#3473)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: Array<string | undefined> = [];
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      (relPath?: string) => {
        calls.push(relPath);
        return Promise.resolve();
      },
    );
    const enc = (s: string) => new TextEncoder().encode(s);

    // Emptied as retention does: floor first, then each version.
    for (const v of ["a", "b", "c"]) {
      await repo.save(testType, "m1", makeData("reaped"), enc(v));
    }
    calls.length = 0;
    await repo.raiseVersionFloor(testType, "m1", "reaped", 3);
    const floorPath = `${
      repo.getDataNameDir(testType, "m1", "reaped")
    }${VERSION_FLOOR_SUFFIX}`;
    // Marked for the push, so other clones get it: before the write and
    // after it (swamp-club#2421).
    assertEquals(calls, [floorPath, floorPath]);
    for (const v of [1, 2, 3]) {
      await repo.delete(testType, "m1", "reaped", v);
    }
    assertEquals(await repo.listVersions(testType, "m1", "reaped"), []);
    const next = await repo.save(testType, "m1", makeData("reaped"), enc("d"));
    assertEquals(next.version, 4);

    // A lower floor never lowers it.
    await repo.raiseVersionFloor(testType, "m1", "reaped", 2);
    assertEquals((await Deno.readTextFile(floorPath)).trim(), "3");

    // A second repository over the same files (another clone after a pull)
    // continues above the floor too.
    const other = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      new CatalogStore(join(tmpDir, "_catalog_other.db")),
    );
    await repo.raiseVersionFloor(testType, "m1", "reaped", 4);
    await repo.delete(testType, "m1", "reaped", 4);
    const fromOther = await other.save(
      testType,
      "m1",
      makeData("reaped"),
      enc("e"),
    );
    assertEquals(fromOther.version, 5);
    // The floor file is no data name.
    assertEquals(
      (await other.findAllForModel(testType, "m1")).map((d) => d.name),
      ["reaped"],
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findByTaggedName: returns a name whose latest version is a deletion marker, not a rename marker (swamp-club#3698)", async () => {
  await withRenameRepo(async (repo, _catalogStore, modelId) => {
    const tagged = (name: string) =>
      Data.create({
        name,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 100,
        tags: { type: "resource", modelName: "ingest" },
        ownerDefinition: owner,
      });
    await repo.save(testType, modelId, tagged("deleted"), new Uint8Array([1]));
    await repo.save(testType, modelId, tagged("old"), new Uint8Array([1]));
    const latest = await repo.findByName(testType, modelId, "deleted");
    await repo.save(
      testType,
      modelId,
      latest!.withDeletionMarker({ version: latest!.version + 1 }),
      new TextEncoder().encode("{}"),
    );
    await repo.rename(testType, modelId, "old", "new");

    const deleted = await repo.findByTaggedName("ingest", "deleted");
    assertEquals(
      deleted.map((
        { data, modelId },
      ) => [data.version, data.isDeleted, modelId]),
      [[2, true, modelId]],
    );
    // The unversioned read follows the forward: the marker is never returned.
    assertEquals(
      (await repo.findByTaggedName("ingest", "old")).map(({ data }) => [
        data.name,
        data.isRenamed,
      ]),
      [["new", false]],
    );
  });
});

Deno.test("delete: measures file removal, catalog upkeep and staging into the running phase", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      () => Promise.resolve(),
    );
    const data = makeData("measured");
    await repo.save(testType, "m1", data, new TextEncoder().encode("v1"));
    await repo.save(testType, "m1", data, new TextEncoder().encode("v2"));
    const versioned = makeData("measured-version");
    await repo.save(testType, "m1", versioned, new TextEncoder().encode("v1"));
    await repo.save(testType, "m1", versioned, new TextEncoder().encode("v2"));

    await withObservedSpans(async (spans) => {
      await withDiagnosticArea(
        "worker_delete",
        () =>
          observeDiagnosticPhase("data_removal", {}, async () => {
            await repo.delete(testType, "m1", "measured");
            await repo.delete(testType, "m1", "measured-version", 2);
            // Already gone: not counted again.
            await repo.delete(testType, "m1", "measured-version", 2);
          }),
      );
      const removal = findSpan(spans, "swamp.diagnostic.data_removal");
      // Two versions of the whole name, then one named version.
      assertEquals(removal.attributes["swamp.diagnostic.versions_removed"], 3);
      for (
        const work of [
          "version_list",
          "file_remove",
          "catalog_update",
          "latest_update",
          "change_stage",
        ]
      ) {
        assertEquals(
          typeof removal.attributes[`swamp.diagnostic.${work}_work_ms`],
          "number",
          work,
        );
      }
    });
    assertEquals(await repo.findByName(testType, "m1", "measured"), null);
    catalogStore.close();
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Durable v2 writes (swamp-club#4017)
// ---------------------------------------------------------------------------

interface DurableHarness {
  repo: FileSystemUnifiedDataRepository;
  dir: string;
  /** Sync and catalog events in order, paths relative to the repo dir. */
  events: string[];
  /** A path's label in `events`. */
  label: (path: string) => string;
}

/**
 * A v2 repository whose sync hooks and catalog publishing calls record
 * what they did, in order.
 */
async function withDurableRepo(
  fn: (h: DurableHarness) => Promise<void>,
  options: {
    baseDir?: (dir: string) => string;
    hooks?: (h: Omit<DurableHarness, "repo">) => Partial<AtomicWriteSync>;
    /** The datastore's `durable` setting; on in this harness. */
    durable?: boolean;
  } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-durable-test-" });
  const catalogStore = new CatalogStore(join(dir, "_catalog.db"));
  const events: string[] = [];
  const label = (path: string) =>
    relative(dir, path).split(SEPARATOR).join("/") || ".";
  const upsert = catalogStore.upsertNewVersion.bind(catalogStore);
  catalogStore.upsertNewVersion = (row) => {
    events.push("catalog");
    return upsert(row);
  };
  const settle = catalogStore.settlePending.bind(catalogStore);
  catalogStore.settlePending = (...args) => {
    events.push("settle");
    return settle(...args);
  };
  const hooks: AtomicWriteSync = {
    syncFile: async (file, paths) => {
      await file.sync();
      events.push(`file ${label(paths.target)}`);
    },
    syncDirectory: (d) => {
      events.push(`dir ${label(d)}`);
      return Promise.resolve();
    },
    ...options.hooks?.({ dir, events, label }),
  };
  try {
    const repo = new FileSystemUnifiedDataRepository(
      dir,
      options.baseDir?.(dir),
      catalogStore,
      undefined,
      undefined,
      SOLO_NAMESPACE,
      false,
      undefined,
      undefined,
      undefined,
      options.durable ?? true,
      hooks,
    );
    await fn({ repo, dir, events, label });
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Asserts `first` was recorded, and before every `then` event. */
function assertBefore(events: string[], first: string, ...then: string[]) {
  const at = events.indexOf(first);
  assert(at >= 0, `${first} missing from ${JSON.stringify(events)}`);
  for (const later of then) {
    const laterAt = events.lastIndexOf(later);
    assert(laterAt >= 0, `${later} missing from ${JSON.stringify(events)}`);
    assert(at < laterAt, `${first} not before ${later}: ${events}`);
  }
}

const dataDir = ".swamp/data/test/model/m1";

Deno.test("save: on v2, syncs the version files and the directories that reach them before the marker and the catalog", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    await repo.save(testType, "m1", makeJsonData("state"), bytes("{}"));
    const v1 = `${dataDir}/state/1`;
    for (const content of [`file ${v1}/metadata.yaml`, `file ${v1}/raw`]) {
      assertBefore(
        events,
        content,
        `dir ${v1}`,
        `file ${dataDir}/state/latest`,
      );
    }
    assertBefore(
      events,
      `dir ${v1}`,
      `dir ${dataDir}/state`,
      `dir ${dataDir}`,
      `file ${dataDir}/state/latest`,
    );
    // The data-name directory is synced again for the marker's rename.
    assertBefore(events, `file ${dataDir}/state/latest`, "catalog");
    assertEquals(events.at(-2), `dir ${dataDir}/state`);
    assertEquals(events.at(-1), "catalog");
  });
});

Deno.test("save: on v2, a first version syncs the parent of every directory it created", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    await repo.save(testType, "m1", makeJsonData("state"), bytes("{}"));
    for (
      const parent of [
        ".",
        ".swamp",
        ".swamp/data",
        ".swamp/data/test",
        ".swamp/data/test/model",
        dataDir,
      ]
    ) {
      assertBefore(events, `dir ${parent}`, `file ${dataDir}/state/latest`);
    }
    events.length = 0;
    await repo.save(testType, "m1", makeJsonData("state"), bytes("{}"));
    assertEquals(events.includes("dir .swamp/data/test"), false);
    // A writer that finds the data-name directory present still syncs the
    // model directory, which holds its entry.
    assertBefore(events, `dir ${dataDir}`, `file ${dataDir}/state/latest`);
  });
});

Deno.test("save: on v2, a data-name directory removed and recreated is synced into its model directory again", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    await repo.save(testType, "m1", makeJsonData("gone"), bytes("{}"));
    await repo.save(testType, "m1", makeJsonData("kept"), bytes("{}"));
    await Deno.remove(repo.getDataNameDir(testType, "m1", "gone"), {
      recursive: true,
    });
    events.length = 0;
    await repo.save(testType, "m1", makeJsonData("gone"), bytes("{}"));
    assertBefore(events, `dir ${dataDir}`, `file ${dataDir}/gone/latest`);
    assertEquals(events.includes("dir .swamp/data/test/model"), false);
  });
});

Deno.test("save: on v2, the first write in a new namespace syncs the datastore directory that holds it", async () => {
  await withDurableRepo(
    async ({ repo, dir, events }) => {
      await Deno.mkdir(join(dir, "ds"));
      await repo.save(testType, "m1", makeJsonData("state"), bytes("{}"));
      assertBefore(
        events,
        "dir ds",
        "file ds/ns/data/test/model/m1/state/latest",
      );
      assertBefore(
        events,
        "dir ds/ns",
        "file ds/ns/data/test/model/m1/state/latest",
      );
    },
    { baseDir: (dir) => join(dir, "ds", "ns", "data") },
  );
});

Deno.test("allocateVersion: on v2, reports durable and syncs the parents of directories it created before returning", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    const allocated = await repo.allocateVersion(
      testType,
      "m1",
      makeJsonData("stream"),
    );
    assertEquals(allocated.durable, true);
    // Its data-name directory and every directory above it were created.
    assert(events.includes(`dir ${dataDir}`));
    assert(events.includes("dir .swamp/data"));
  });
});

Deno.test("saveDeferred and advanceLatestMarkers: on v2, the version is durable before it settles and the marker moves", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    const receipt = await repo.saveDeferred(
      testType,
      "m1",
      makeJsonData("state"),
      bytes("{}"),
    );
    const v1 = `${dataDir}/state/1`;
    assert(events.includes(`file ${v1}/raw`));
    assert(events.includes(`dir ${dataDir}/state`));
    await repo.advanceLatestMarkers([receipt]);
    assertBefore(
      events,
      `file ${v1}/raw`,
      "settle",
      `file ${dataDir}/state/latest`,
      "catalog",
    );
    assertBefore(events, `dir ${v1}`, "settle");
  });
});

Deno.test("advanceLatestMarkers: on v2, a writer that never finalized has its raw, version directory and reach synced before it settles", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    const allocated = await repo.allocateVersion(
      testType,
      "m1",
      makeJsonData("log"),
      { deferred: true },
    );
    await Deno.writeTextFile(allocated.contentPath, "partial line\n");
    events.length = 0;
    await repo.advanceLatestMarkers([{
      type: testType,
      modelId: "m1",
      dataName: "log",
      version: allocated.version,
    }]);
    const v1 = `${dataDir}/log/1`;
    assertBefore(
      events,
      `file ${v1}/raw`,
      `dir ${v1}`,
      "settle",
      `file ${dataDir}/log/latest`,
    );
    assertBefore(events, `dir ${dataDir}/log`, "settle");
    assertBefore(events, `dir ${dataDir}`, "settle");
  });
});

Deno.test("append: on v2, syncs the appended content and the metadata before the catalog", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    await repo.save(testType, "m1", makeStreamingData("log"), bytes("a\n"));
    events.length = 0;
    await repo.append(testType, "m1", "log", bytes("b\n"));
    const v1 = `${dataDir}/log/1`;
    assertBefore(events, `file ${v1}/raw`, `file ${v1}/metadata.yaml`);
    assertBefore(events, `file ${v1}/metadata.yaml`, `dir ${v1}`, "catalog");
  });
});

Deno.test("finalizeVersion: on v2, syncs raw only when the writer did not", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    for (const contentSynced of [true, false]) {
      const name = contentSynced ? "streamed" : "subprocess";
      const data = makeJsonData(name);
      const allocated = await repo.allocateVersion(testType, "m1", data);
      await Deno.writeTextFile(allocated.contentPath, "{}");
      if (!contentSynced && Deno.build.os !== "windows") {
        // A subprocess may leave its output read-only.
        await Deno.chmod(allocated.contentPath, 0o444);
      }
      events.length = 0;
      await repo.finalizeVersion(
        testType,
        "m1",
        data,
        allocated.version,
        allocated.priorVersions,
        { contentSynced },
      );
      const v1 = `${dataDir}/${name}/1`;
      assertEquals(events.includes(`file ${v1}/raw`), !contentSynced);
      assertBefore(
        events,
        `file ${v1}/metadata.yaml`,
        `dir ${v1}`,
        `dir ${dataDir}/${name}`,
        `file ${dataDir}/${name}/latest`,
        "catalog",
      );
      if (!contentSynced) {
        assertBefore(events, `file ${v1}/raw`, `file ${v1}/metadata.yaml`);
      }
    }
  });
});

Deno.test("finalizeVersionDeferred: on v2, the version is synced before its pending row is completed", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    const data = makeJsonData("deferred");
    const allocated = await repo.allocateVersion(testType, "m1", data, {
      deferred: true,
    });
    await Deno.writeTextFile(allocated.contentPath, "{}");
    events.length = 0;
    await repo.finalizeVersionDeferred(
      testType,
      "m1",
      data,
      allocated.version,
      allocated.priorVersions,
    );
    const v1 = `${dataDir}/deferred/1`;
    assertBefore(events, `file ${v1}/raw`, `file ${v1}/metadata.yaml`);
    assertBefore(events, `dir ${v1}`, `dir ${dataDir}/deferred`);
    assertEquals(events.includes("catalog"), false);
  });
});

Deno.test("rename: on v2, the copy and the tombstone are each synced before their marker", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    await repo.save(testType, "m1", makeJsonData("old"), bytes("{}"));
    events.length = 0;
    await repo.rename(testType, "m1", "old", "new");
    assertBefore(
      events,
      `file ${dataDir}/new/1/raw`,
      `dir ${dataDir}/new/1`,
      `file ${dataDir}/new/latest`,
    );
    assertBefore(
      events,
      `file ${dataDir}/old/2/raw`,
      `dir ${dataDir}/old/2`,
      `dir ${dataDir}/old`,
      `file ${dataDir}/old/latest`,
    );
  });
});

Deno.test("delete: on v2, rewrites the marker durably and never removes it first", async () => {
  await withDurableRepo(
    async ({ repo, events }) => {
      await repo.save(testType, "m1", makeJsonData("state"), bytes("1"));
      await repo.save(testType, "m1", makeJsonData("state"), bytes("2"));
      events.length = 0;
      await repo.delete(testType, "m1", "state", 2);
      assert(events.includes(`file ${dataDir}/state/latest present`));
      assertEquals(
        await Deno.readTextFile(
          join(repo.getDataNameDir(testType, "m1", "state"), "latest"),
        ),
        "1",
      );
    },
    {
      hooks: ({ events, label }) => ({
        syncFile: async (file, paths) => {
          await file.sync();
          let present = true;
          try {
            await Deno.stat(paths.target);
          } catch {
            present = false;
          }
          events.push(
            `file ${label(paths.target)}${present ? " present" : ""}`,
          );
        },
      }),
    },
  );
});

Deno.test({
  name: "delete: on v2, still replaces a legacy latest symlink",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withDurableRepo(async ({ repo }) => {
      await repo.save(testType, "m1", makeJsonData("state"), bytes("1"));
      await repo.save(testType, "m1", makeJsonData("state"), bytes("2"));
      const latest = join(
        repo.getDataNameDir(testType, "m1", "state"),
        "latest",
      );
      await Deno.remove(latest);
      await Deno.symlink("2", latest, { type: "dir" });
      await repo.delete(testType, "m1", "state", 2);
      assertEquals((await Deno.lstat(latest)).isSymlink, false);
      assertEquals(await Deno.readTextFile(latest), "1");
    });
  },
});

Deno.test("finalizeVersion: on v2, a lower version that finishes last never moves the marker back (swamp-club#2520)", async () => {
  let releaseLower!: () => void;
  const lowerHeld = new Promise<void>((resolve) => releaseLower = resolve);
  await withDurableRepo(
    async ({ repo }) => {
      const data = makeJsonData("state");
      const first = await repo.allocateVersion(testType, "m1", data);
      const second = await repo.allocateVersion(testType, "m1", data);
      await Deno.writeTextFile(first.contentPath, "1");
      await Deno.writeTextFile(second.contentPath, "2");
      await Promise.all([
        repo.finalizeVersion(testType, "m1", data, first.version),
        repo.finalizeVersion(testType, "m1", data, second.version),
      ]);
      const nameDir = repo.getDataNameDir(testType, "m1", "state");
      assertEquals(await Deno.readTextFile(join(nameDir, "latest")), "2");
      const leftovers: string[] = [];
      for await (const entry of Deno.readDir(nameDir)) {
        if (entry.name.endsWith(".tmp")) leftovers.push(entry.name);
      }
      assertEquals(leftovers, []);
    },
    {
      hooks: () => ({
        syncFile: async (file, paths) => {
          await file.sync();
          if (
            paths.target.endsWith("latest") &&
            (await Deno.readTextFile(paths.temp)) === "1"
          ) {
            await lowerHeld;
          }
        },
        syncDirectory: async (d) => {
          try {
            if ((await Deno.readTextFile(join(d, "latest"))) === "2") {
              releaseLower();
            }
          } catch {
            // No marker yet
          }
        },
      }),
    },
  );
});

Deno.test("save: on v3, the version is not synced by the repository", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    const unit = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(new MemorySink(), new MemoryStorage()),
    );
    try {
      await runInUnitOfWork(unit, async () => {
        const modelId = crypto.randomUUID();
        await repo.save(testType, modelId, makeJsonData("state"), bytes("{}"));
        const allocated = await repo.allocateVersion(
          testType,
          modelId,
          makeJsonData("stream"),
        );
        assertEquals(allocated.durable, false);
      });
    } finally {
      await unit.abandon();
    }
    assertEquals(
      events.filter((e) => e.startsWith("file ") || e.startsWith("dir ")),
      [],
    );
  });
});

Deno.test({
  name:
    "save: a dangling symlink above the data-name directory fails instead of retrying forever",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withDurableRepo(async ({ repo, dir }) => {
      const modelDir = dirname(repo.getDataNameDir(testType, "m1", "state"));
      await Deno.mkdir(dirname(modelDir), { recursive: true });
      await Deno.symlink(join(dir, "gone"), modelDir, { type: "dir" });
      await assertRejects(
        () => repo.save(testType, "m1", makeJsonData("state"), bytes("{}")),
        Deno.errors.NotFound,
      );
    });
  },
});

Deno.test("save: with durable writes off, no write syncs anything and allocateVersion reports not durable", async () => {
  await withDurableRepo(async ({ repo, events }) => {
    await repo.save(testType, "m1", makeJsonData("state"), bytes("{}"));
    await repo.save(testType, "m1", makeStreamingData("log"), bytes("a\n"));
    await repo.append(testType, "m1", "log", bytes("b\n"));
    const data = makeJsonData("stream");
    const allocated = await repo.allocateVersion(testType, "m1", data);
    assertEquals(allocated.durable, false);
    await Deno.writeTextFile(allocated.contentPath, "{}");
    await repo.finalizeVersion(testType, "m1", data, allocated.version);
    await repo.rename(testType, "m1", "state", "renamed");
    await repo.delete(testType, "m1", "stream", allocated.version);
    assertEquals(
      events.filter((e) => e.startsWith("file ") || e.startsWith("dir ")),
      [],
    );
    assertEquals(
      await Deno.readTextFile(
        join(repo.getDataNameDir(testType, "m1", "renamed"), "latest"),
      ),
      "1",
    );
  }, { durable: false });
});

Deno.test("save: on v2, a failed directory sync stops the version before the marker and the catalog, naming the directory", async () => {
  await withDurableRepo(
    async ({ repo, events }) => {
      await repo.save(testType, "m1", makeJsonData("state"), bytes("1"));
      events.length = 0;
      const error = await assertRejects(
        () => repo.save(testType, "m1", makeJsonData("state"), bytes("2")),
        SyncFailedError,
      );
      assertStringIncludes(error.message, join("state", "2"));
      assertStringIncludes(error.message, "Input/output error");
      assertEquals(
        await Deno.readTextFile(
          join(repo.getDataNameDir(testType, "m1", "state"), "latest"),
        ),
        "1",
      );
      assertEquals(events.includes("catalog"), false);
    },
    {
      hooks: ({ events, label }) => ({
        syncDirectory: (d) => {
          events.push(`dir ${label(d)}`);
          return label(d) === `${dataDir}/state/2`
            ? Promise.reject(new Error("Input/output error (os error 5)"))
            : Promise.resolve();
        },
      }),
    },
  );
});

/**
 * Sync hooks that fail the data-name directory's sync once the latest
 * marker names `version`: the sync after the marker's rename.
 */
function failSyncAfterMarkerMoves(
  version: number,
): (h: Omit<DurableHarness, "repo">) => Partial<AtomicWriteSync> {
  return ({ dir, events, label }) => ({
    syncDirectory: (d) => {
      events.push(`dir ${label(d)}`);
      if (label(d) !== `${dataDir}/state`) return Promise.resolve();
      let marker: string | undefined;
      try {
        marker = Deno.readTextFileSync(join(dir, dataDir, "state", "latest"));
      } catch {
        // No marker yet
      }
      return marker === String(version)
        ? Promise.reject(new Error("Input/output error (os error 5)"))
        : Promise.resolve();
    },
  });
}

Deno.test("save: on v2, a failed sync after the marker moved still publishes the catalog row, so the two agree", async () => {
  await withDurableRepo(
    async ({ repo, events }) => {
      await repo.save(testType, "m1", makeJsonData("state"), bytes("1"));
      events.length = 0;
      const error = await assertRejects(
        () => repo.save(testType, "m1", makeJsonData("state"), bytes("2")),
        SyncFailedError,
      );
      assertStringIncludes(error.message, "Input/output error");
      assertEquals(
        await Deno.readTextFile(
          join(repo.getDataNameDir(testType, "m1", "state"), "latest"),
        ),
        "2",
      );
      assertBefore(events, `file ${dataDir}/state/latest`, "catalog");
    },
    { hooks: failSyncAfterMarkerMoves(2) },
  );
});

Deno.test("advanceLatestMarkers: on v2, a failed sync after the marker moved still publishes the catalog row", async () => {
  await withDurableRepo(
    async ({ repo, events }) => {
      await repo.save(testType, "m1", makeJsonData("state"), bytes("1"));
      const receipt = await repo.saveDeferred(
        testType,
        "m1",
        makeJsonData("state"),
        bytes("2"),
      );
      events.length = 0;
      // A promotion failure is logged, as before.
      await repo.advanceLatestMarkers([receipt]);
      assertEquals(
        await Deno.readTextFile(
          join(repo.getDataNameDir(testType, "m1", "state"), "latest"),
        ),
        "2",
      );
      assertBefore(events, `file ${dataDir}/state/latest`, "catalog");
    },
    { hooks: failSyncAfterMarkerMoves(2) },
  );
});

Deno.test("save: on v2, a failed file sync names the file it was writing", async () => {
  await withDurableRepo(
    async ({ repo }) => {
      const error = await assertRejects(
        () => repo.save(testType, "m1", makeJsonData("state"), bytes("{}")),
        SyncFailedError,
      );
      assertStringIncludes(error.message, "Could not sync ");
      assertStringIncludes(error.message, join("state", "1", "raw"));
      assertStringIncludes(error.message, "Input/output error");
    },
    {
      hooks: () => ({
        syncFile: (_file, paths) =>
          paths.target.endsWith("raw")
            ? Promise.reject(new Error("Input/output error (os error 5)"))
            : Promise.resolve(),
      }),
    },
  );
});

// --- swamp-club#3955: reads warn on published unreadable versions ---

interface UnreadableFixture {
  dir: string;
  catalog: CatalogStore;
  repo: FileSystemUnifiedDataRepository;
  modelId: string;
  versionDir: (version: number) => string;
}

/**
 * A repo holding three versions of `state`, each with JSON content; `make`
 * builds the repository read through, by default a plain v2 one.
 */
async function withUnreadableFixture(
  fn: (f: UnreadableFixture) => Promise<void>,
  make: (
    dir: string,
    catalog: CatalogStore,
  ) => FileSystemUnifiedDataRepository = (dir, catalog) =>
    new FileSystemUnifiedDataRepository(dir, undefined, catalog),
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-unreadable-read-" });
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  const modelId = crypto.randomUUID();
  try {
    const writer = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
    for (let i = 1; i <= 3; i++) {
      await writer.save(
        testType,
        modelId,
        makeJsonData("state"),
        new TextEncoder().encode(JSON.stringify({ stageId: `s${i}` })),
      );
    }
    await fn({
      dir,
      catalog,
      repo: make(dir, catalog),
      modelId,
      versionDir: (version) =>
        writer.getPath(testType, modelId, "state", version),
    });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const REPOSITORY_LOG = ["data", "repository"];

Deno.test("findByName: an empty metadata.yaml on the published latest version warns once and still reads as not found (swamp-club#3955)", async () => {
  await withUnreadableFixture(async (f) => {
    await Deno.writeFile(
      join(f.versionDir(3), "metadata.yaml"),
      new Uint8Array(),
    );
    let found: unknown = "unset";
    const warnings = await captureUnreadableWarnings(async () => {
      found = await f.repo.findByName(testType, f.modelId, "state");
      await f.repo.findByName(testType, f.modelId, "state");
    }, REPOSITORY_LOG);
    assertEquals(found, null);
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0], "Version 3");
    assertStringIncludes(warnings[0], "metadata.yaml is empty");
    assertStringIncludes(warnings[0], "swamp doctor datastores --repair");
  });
});

Deno.test("isContentAcceptedSync: a published version stored short warns once and is still accepted (swamp-club#3955)", async () => {
  await withUnreadableFixture(async (f) => {
    await Deno.writeFile(join(f.versionDir(3), "raw"), new Uint8Array());
    const accepted: boolean[] = [];
    const warnings = await captureUnreadableWarnings(() => {
      for (let i = 0; i < 2; i++) {
        accepted.push(
          f.repo.isContentAcceptedSync(testType, f.modelId, "state", 3, 15),
        );
      }
      return Promise.resolve();
    }, REPOSITORY_LOG);
    assertEquals(accepted, [true, true]);
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0], "shorter than its metadata records");
  });
});

Deno.test("getContent and getContentSync: a published version whose raw is missing warns, and still returns null (swamp-club#3955)", async () => {
  await withUnreadableFixture(async (f) => {
    await Deno.remove(join(f.versionDir(3), "raw"));
    await Deno.remove(join(f.versionDir(2), "raw"));
    const read: unknown[] = [];
    const warnings = await captureUnreadableWarnings(async () => {
      read.push(await f.repo.getContent(testType, f.modelId, "state", 3));
      read.push(f.repo.getContentSync(testType, f.modelId, "state", 2));
    }, REPOSITORY_LOG);
    assertEquals(read, [null, null]);
    assertEquals(warnings.length, 2, warnings.join("\n"));
    assertStringIncludes(warnings[0], "Version 3");
    assertStringIncludes(warnings[1], "Version 2");
    assertStringIncludes(warnings[1], "raw content file is missing");
  });
});

Deno.test("getContent: a zero-byte raw whose catalog row records content warns (swamp-club#3955)", async () => {
  await withUnreadableFixture(async (f) => {
    await Deno.writeFile(join(f.versionDir(3), "raw"), new Uint8Array());
    let bytes: Uint8Array | null = null;
    const warnings = await captureUnreadableWarnings(async () => {
      bytes = await f.repo.getContent(testType, f.modelId, "state");
    }, REPOSITORY_LOG);
    assertEquals(bytes, new Uint8Array());
    assertEquals(warnings.length, 1, warnings.join("\n"));
  });
});

Deno.test("reads: a version that is not published, or whose metadata is missing too, is never warned about (swamp-club#3955)", async () => {
  await withUnreadableFixture(async (f) => {
    // A save in flight: metadata written, raw not yet, no catalog row, and
    // the marker still names version 3.
    await Deno.mkdir(f.versionDir(4));
    await Deno.copyFile(
      join(f.versionDir(3), "metadata.yaml"),
      join(f.versionDir(4), "metadata.yaml"),
    );
    // A version whose metadata and raw are both gone.
    await Deno.remove(join(f.versionDir(2), "metadata.yaml"));
    await Deno.remove(join(f.versionDir(2), "raw"));
    const warnings = await captureUnreadableWarnings(async () => {
      assertEquals(
        await f.repo.getContent(testType, f.modelId, "state", 4),
        null,
      );
      assertEquals(
        f.repo.getContentSync(testType, f.modelId, "state", 4),
        null,
      );
      assertEquals(
        await f.repo.findByName(testType, f.modelId, "state", 2),
        null,
      );
    }, REPOSITORY_LOG);
    assertEquals(warnings, []);
  });
});

Deno.test("reads: a pending deferred write is never warned about (swamp-club#3955)", async () => {
  await withUnreadableFixture(async (f) => {
    const receipt = await f.repo.saveDeferred(
      testType,
      f.modelId,
      makeJsonData("state"),
      new TextEncoder().encode("{}"),
    );
    await Deno.remove(join(f.versionDir(receipt.version), "raw"));
    const warnings = await captureUnreadableWarnings(async () => {
      await f.repo.getContent(testType, f.modelId, "state", receipt.version);
    }, REPOSITORY_LOG);
    assertEquals(warnings, []);
  });
});

Deno.test("reads: a repository with a hydrate hook, or a v3 one, does not check (swamp-club#3955)", async () => {
  const makers: Array<
    (dir: string, catalog: CatalogStore) => FileSystemUnifiedDataRepository
  > = [
    (dir, catalog) =>
      new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        catalog,
        undefined,
        () => Promise.resolve(false),
      ),
    (dir, catalog) =>
      new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        catalog,
        undefined,
        undefined,
        SOLO_NAMESPACE,
        false,
        undefined,
        undefined,
        () => Promise.resolve(undefined),
      ),
  ];
  for (const make of makers) {
    await withUnreadableFixture(async (f) => {
      await Deno.writeFile(
        join(f.versionDir(3), "metadata.yaml"),
        new Uint8Array(),
      );
      await Deno.remove(join(f.versionDir(2), "raw"));
      const warnings = await captureUnreadableWarnings(async () => {
        await f.repo.findByName(testType, f.modelId, "state");
        await f.repo.getContent(testType, f.modelId, "state", 2);
      }, REPOSITORY_LOG);
      assertEquals(warnings, []);
    }, make);
  }
});

Deno.test("resetLatestMarkerToReadable: points an empty marker at the highest readable version, or leaves it when none is (swamp-club#3955)", async () => {
  await withUnreadableFixture(async (f) => {
    const marker = join(f.versionDir(1), "..", "latest");
    await Deno.writeFile(marker, new Uint8Array());
    await Deno.writeFile(
      join(f.versionDir(3), "metadata.yaml"),
      new Uint8Array(),
    );
    assertEquals(
      await f.repo.latestMarkerState(testType, f.modelId, "state"),
      { kind: "unreadable" },
    );
    assertEquals(
      await f.repo.resetLatestMarkerToReadable(testType, f.modelId, "state"),
      2,
    );
    assertEquals(await Deno.readTextFile(marker), "2");

    for (const version of [1, 2]) {
      await Deno.writeFile(
        join(f.versionDir(version), "metadata.yaml"),
        new Uint8Array(),
      );
    }
    await Deno.writeFile(marker, new Uint8Array());
    assertEquals(
      await f.repo.resetLatestMarkerToReadable(testType, f.modelId, "state"),
      null,
    );
    assertEquals(await Deno.readTextFile(marker), "");
  });
});

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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createDataDeleteDeps,
  dataBatchDelete,
  type DataBatchDeleteEvent,
  dataBatchDeletePreview,
  dataDelete,
  type DataDeleteDeps,
  type DataDeleteEvent,
  dataDeletePreview,
} from "./delete.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { catalogDbPath } from "../../infrastructure/persistence/repository_factory.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles
      // yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function catalogDbExists(repoDir: string): Promise<boolean> {
  try {
    await Deno.lstat(catalogDbPath(repoDir));
    return true;
  } catch {
    return false;
  }
}

Deno.test(
  "createDataDeleteDeps: reuses an injected data repo and opens no new catalog db",
  async () => {
    await withTempDir(async (dir) => {
      const injected = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        new CatalogStore(":memory:"),
      );
      createDataDeleteDeps(dir, undefined, injected);
      assertEquals(await catalogDbExists(dir), false);
    });
  },
);

Deno.test(
  "createDataDeleteDeps: opens a file-based catalog db when no repo is injected",
  async () => {
    await withTempDir(async (dir) => {
      createDataDeleteDeps(dir);
      assertEquals(await catalogDbExists(dir), true);
    });
  },
);

function makeDeps(overrides: Partial<DataDeleteDeps> = {}): DataDeleteDeps {
  return {
    delete: () =>
      Promise.resolve({
        modelId: "def-1",
        modelName: "my-model",
        modelType: "test/example",
        dataName: "my-data",
        version: undefined,
        versionsDeleted: 3,
      }),
    preview: () =>
      Promise.resolve({
        modelId: "def-1",
        modelName: "my-model",
        modelType: "test/example",
        dataName: "my-data",
        versionsCount: 3,
      }),
    batchDelete: () =>
      Promise.resolve({
        modelId: "def-1",
        modelName: "my-model",
        modelType: "test/example",
        deleted: [
          { dataName: "run-001", versionsDeleted: 1 },
          { dataName: "run-002", versionsDeleted: 2 },
        ],
        failed: [],
        totalDeleted: 2,
        totalVersionsDeleted: 3,
      }),
    batchPreview: () =>
      Promise.resolve({
        modelId: "def-1",
        modelName: "my-model",
        modelType: "test/example",
        matchingItems: [
          { dataName: "run-001", versionsCount: 1 },
          { dataName: "run-002", versionsCount: 2 },
        ],
        totalItems: 2,
        totalVersions: 3,
      }),
    ...overrides,
  };
}

Deno.test("dataDelete: yields completed for full-artifact delete", async () => {
  const deps = makeDeps();

  const events = await collect<DataDeleteEvent>(
    dataDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      dataName: "my-data",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "deleting" });
  const completed = events[1] as Extract<
    DataDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.modelId, "def-1");
  assertEquals(completed.data.modelName, "my-model");
  assertEquals(completed.data.modelType, "test/example");
  assertEquals(completed.data.dataName, "my-data");
  assertEquals(completed.data.version, undefined);
  assertEquals(completed.data.versionsDeleted, 3);
});

Deno.test("dataDelete: yields completed for single-version delete", async () => {
  const deps = makeDeps({
    delete: () =>
      Promise.resolve({
        modelId: "def-1",
        modelName: "my-model",
        modelType: "test/example",
        dataName: "my-data",
        version: 2,
        versionsDeleted: 1,
      }),
  });

  const events = await collect<DataDeleteEvent>(
    dataDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      dataName: "my-data",
      version: 2,
    }),
  );

  const completed = events[1] as Extract<
    DataDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.version, 2);
  assertEquals(completed.data.versionsDeleted, 1);
});

Deno.test("dataDelete: yields error when service throws (model not found)", async () => {
  const deps = makeDeps({
    delete: () => {
      throw new Error("Model not found: missing");
    },
  });

  const events = await collect<DataDeleteEvent>(
    dataDelete(createLibSwampContext(), deps, {
      modelIdOrName: "missing",
      dataName: "my-data",
    }),
  );

  assertEquals(events.length, 2);
  const last = events[1] as Extract<DataDeleteEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertEquals(last.error.message, "Model not found: missing");
});

Deno.test("dataDelete: yields error when service throws (artifact missing)", async () => {
  const deps = makeDeps({
    delete: () => {
      throw new Error('No data named "x" exists for model y');
    },
  });

  const events = await collect<DataDeleteEvent>(
    dataDelete(createLibSwampContext(), deps, {
      modelIdOrName: "y",
      dataName: "x",
    }),
  );

  const last = events[1] as Extract<DataDeleteEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("dataDelete: yields error when service throws (version not found)", async () => {
  const deps = makeDeps({
    delete: () => {
      throw new Error(
        'Version 99 does not exist for "my-data" (available versions: 1, 2, 3)',
      );
    },
  });

  const events = await collect<DataDeleteEvent>(
    dataDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      dataName: "my-data",
      version: 99,
    }),
  );

  const last = events[1] as Extract<DataDeleteEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("dataDeletePreview: returns version count without invoking delete", async () => {
  let deleteCalled = false;
  const deps = makeDeps({
    delete: () => {
      deleteCalled = true;
      return Promise.resolve({
        modelId: "def-1",
        modelName: "my-model",
        modelType: "test/example",
        dataName: "my-data",
        version: undefined,
        versionsDeleted: 3,
      });
    },
  });

  const preview = await dataDeletePreview(createLibSwampContext(), deps, {
    modelIdOrName: "my-model",
    dataName: "my-data",
  });

  assertEquals(preview.versionsCount, 3);
  assertEquals(preview.modelName, "my-model");
  assertEquals(preview.modelType, "test/example");
  assertEquals(deleteCalled, false);
});

// --- Batch delete tests ---

Deno.test("dataBatchDelete: yields completed with aggregated stats", async () => {
  const deps = makeDeps();

  const events = await collect<DataBatchDeleteEvent>(
    dataBatchDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      filter: { kind: "prefix", value: "run-" },
      dryRun: false,
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "deleting" });
  const completed = events[1] as Extract<
    DataBatchDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.totalDeleted, 2);
  assertEquals(completed.data.totalVersionsDeleted, 3);
  assertEquals(completed.data.failed.length, 0);
  assertEquals(completed.data.dryRun, false);
});

Deno.test("dataBatchDelete: dry run uses preview without deleting", async () => {
  let batchDeleteCalled = false;
  const deps = makeDeps({
    batchDelete: () => {
      batchDeleteCalled = true;
      return Promise.resolve({
        modelId: "def-1",
        modelName: "my-model",
        modelType: "test/example",
        deleted: [],
        failed: [],
        totalDeleted: 0,
        totalVersionsDeleted: 0,
      });
    },
  });

  const events = await collect<DataBatchDeleteEvent>(
    dataBatchDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      filter: { kind: "all" },
      dryRun: true,
    }),
  );

  assertEquals(batchDeleteCalled, false);
  const completed = events[1] as Extract<
    DataBatchDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.dryRun, true);
  assertEquals(completed.data.totalDeleted, 2);
  assertEquals(completed.data.totalVersionsDeleted, 3);
});

Deno.test("dataBatchDelete: yields error when service throws", async () => {
  const deps = makeDeps({
    batchDelete: () => {
      throw new Error("Model not found: missing");
    },
  });

  const events = await collect<DataBatchDeleteEvent>(
    dataBatchDelete(createLibSwampContext(), deps, {
      modelIdOrName: "missing",
      filter: { kind: "all" },
      dryRun: false,
    }),
  );

  const last = events[1] as Extract<DataBatchDeleteEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("dataBatchDeletePreview: returns matching items without deleting", async () => {
  let batchDeleteCalled = false;
  const deps = makeDeps({
    batchDelete: () => {
      batchDeleteCalled = true;
      return Promise.resolve({
        modelId: "def-1",
        modelName: "my-model",
        modelType: "test/example",
        deleted: [],
        failed: [],
        totalDeleted: 0,
        totalVersionsDeleted: 0,
      });
    },
  });

  const preview = await dataBatchDeletePreview(createLibSwampContext(), deps, {
    modelIdOrName: "my-model",
    filter: { kind: "prefix", value: "run-" },
  });

  assertEquals(preview.totalItems, 2);
  assertEquals(preview.totalVersions, 3);
  assertEquals(preview.matchingItems.length, 2);
  assertEquals(batchDeleteCalled, false);
});

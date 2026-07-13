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
  createDataRenameDeps,
  dataRename,
  type DataRenameDeps,
  type DataRenameEvent,
} from "./rename.ts";
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
  "createDataRenameDeps: reuses an injected data repo and opens no new catalog db",
  async () => {
    await withTempDir(async (dir) => {
      const injected = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        new CatalogStore(":memory:"),
      );
      createDataRenameDeps(dir, undefined, injected);
      assertEquals(await catalogDbExists(dir), false);
    });
  },
);

Deno.test(
  "createDataRenameDeps: opens a file-based catalog db when no repo is injected",
  async () => {
    await withTempDir(async (dir) => {
      createDataRenameDeps(dir);
      assertEquals(await catalogDbExists(dir), true);
    });
  },
);

function makeDeps(overrides: Partial<DataRenameDeps> = {}): DataRenameDeps {
  return {
    rename: () =>
      Promise.resolve({
        oldName: "old-data",
        newName: "new-data",
        modelId: "def-1",
        modelName: "my-model",
        modelType: "aws/s3-bucket",
        copiedVersion: 2,
        newVersion: 3,
      }),
    ...overrides,
  };
}

Deno.test("dataRename: yields completed on successful rename", async () => {
  const deps = makeDeps();

  const events = await collect<DataRenameEvent>(
    dataRename(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      oldName: "old-data",
      newName: "new-data",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "renaming" });
  const completed = events[1] as Extract<
    DataRenameEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.oldName, "old-data");
  assertEquals(completed.data.newName, "new-data");
  assertEquals(completed.data.modelId, "def-1");
  assertEquals(completed.data.modelName, "my-model");
  assertEquals(completed.data.modelType, "aws/s3-bucket");
  assertEquals(completed.data.copiedVersion, 2);
  assertEquals(completed.data.newVersion, 3);
});

Deno.test("dataRename: yields error when names are identical", async () => {
  const deps = makeDeps();

  const events = await collect<DataRenameEvent>(
    dataRename(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      oldName: "same-name",
      newName: "same-name",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "renaming" });
  const last = events[1] as Extract<DataRenameEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("dataRename: yields error when rename service fails", async () => {
  const deps = makeDeps({
    rename: () => {
      throw new Error("Data not found");
    },
  });

  const events = await collect<DataRenameEvent>(
    dataRename(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      oldName: "old-data",
      newName: "new-data",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "renaming" });
  const last = events[1] as Extract<DataRenameEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

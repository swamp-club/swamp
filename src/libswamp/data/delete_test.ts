// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  dataDelete,
  type DataDeleteDeps,
  type DataDeleteEvent,
  dataDeletePreview,
} from "./delete.ts";

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

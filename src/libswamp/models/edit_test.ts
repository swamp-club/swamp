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
import { modelEdit, type ModelEditDeps, type ModelEditEvent } from "./edit.ts";

function makeDeps(overrides: Partial<ModelEditDeps> = {}): ModelEditDeps {
  return {
    lookupDefinition: () => Promise.resolve(null),
    resolveSymlink: () => Promise.resolve(null),
    getDefinitionPath: () => "/fake/path/definition.yaml",
    openEditor: () => Promise.resolve({ editor: "VS Code" }),
    updateFromStdin: () =>
      Promise.resolve(
        {
          name: "updated",
        } as unknown as import("../../domain/definitions/definition.ts").Definition,
      ),
    ...overrides,
  };
}

const testDefinition = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "my-model",
  version: 3,
  tags: { env: "prod" },
  globalArguments: { region: "us-east-1" },
} as unknown as import("../../domain/definitions/definition.ts").Definition;

const testModelType = {
  normalized: "aws/s3-bucket",
} as unknown as import("../../domain/models/model_type.ts").ModelType;

Deno.test("modelEdit: yields error when model not found", async () => {
  const deps = makeDeps();

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "missing-model",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<ModelEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("modelEdit: opens editor when model found", async () => {
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({
        definition: testDefinition,
        type: testModelType,
      }),
    getDefinitionPath: () => "/repo/models/my-model/definition.yaml",
    openEditor: () => Promise.resolve({ editor: "Neovim" }),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        path: "/repo/models/my-model/definition.yaml",
        editor: "Neovim",
        status: "opened",
        name: "my-model",
        type: "aws/s3-bucket",
        editType: "definition",
      },
    },
  ]);
});

Deno.test("modelEdit: falls back to symlink when lookup fails", async () => {
  const deps = makeDeps({
    lookupDefinition: () => {
      throw new Error("Broken YAML");
    },
    resolveSymlink: () =>
      Promise.resolve("/repo/extensions/models/broken/definition.yaml"),
    openEditor: () => Promise.resolve({ editor: "VS Code" }),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "broken",
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        path: "/repo/extensions/models/broken/definition.yaml",
        editor: "VS Code",
        status: "opened",
        name: "broken",
        type: "unknown",
        editType: "definition",
      },
    },
  ]);
});

Deno.test("modelEdit: updates from stdin when content provided", async () => {
  let updateCalled = false;

  const updatedDefinition = {
    name: "updated-model",
  } as unknown as import("../../domain/definitions/definition.ts").Definition;

  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({
        definition: testDefinition,
        type: testModelType,
      }),
    getDefinitionPath: () => "/repo/models/my-model/definition.yaml",
    updateFromStdin: () => {
      updateCalled = true;
      return Promise.resolve(updatedDefinition);
    },
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: updated-model\nversion: 1\n",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    ModelEditEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "updated");
  assertEquals(completed.data.name, "updated-model");
  assertEquals(completed.data.type, "aws/s3-bucket");
  assertEquals(updateCalled, true);
});

Deno.test("modelEdit: yields error when updateFromStdin throws", async () => {
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({
        definition: testDefinition,
        type: testModelType,
      }),
    getDefinitionPath: () => "/repo/models/my-model/definition.yaml",
    updateFromStdin: () => {
      throw new Error("Invalid YAML");
    },
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "bad yaml",
    }),
  );

  const last = events[1] as Extract<ModelEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("modelEdit: yields error for broken model with stdin", async () => {
  const deps = makeDeps({
    lookupDefinition: () => {
      throw new Error("Broken YAML");
    },
    resolveSymlink: () =>
      Promise.resolve("/repo/models/broken/definition.yaml"),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "broken",
      stdinContent: "name: foo\n",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<ModelEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

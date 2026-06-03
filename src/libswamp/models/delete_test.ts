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
  modelDelete,
  type ModelDeleteDeps,
  type ModelDeleteEvent,
  modelDeletePreview,
} from "./delete.ts";

const testDefinition = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "my-model",
} as unknown as import("../../domain/definitions/definition.ts").Definition;

const testModelType = {
  normalized: "aws/s3-bucket",
} as unknown as import("../../domain/models/model_type.ts").ModelType;

function makeDeps(overrides: Partial<ModelDeleteDeps> = {}): ModelDeleteDeps {
  return {
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    findAllWorkflows: () => Promise.resolve([]),
    findDataArtifacts: () => Promise.resolve([]),
    findOutputs: () => Promise.resolve([]),
    getDefinitionPath: () => "/repo/models/my-model/definition.yaml",
    deleteOutput: () => Promise.resolve(),
    deleteData: () => Promise.resolve(),
    deleteDefinition: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("modelDeletePreview: returns preview data", async () => {
  const deps = makeDeps({
    findDataArtifacts: () =>
      Promise.resolve([{ name: "data1" }, { name: "data2" }]),
    findOutputs: () => Promise.resolve([{ id: "o1", methodName: "validate" }]),
  });

  const preview = await modelDeletePreview(
    createLibSwampContext(),
    deps,
    { modelIdOrName: "my-model", force: false },
  );

  assertEquals(preview.name, "my-model");
  assertEquals(preview.dataArtifactCount, 2);
  assertEquals(preview.outputCount, 1);
  assertEquals(preview.referencingWorkflows, []);
});

Deno.test("modelDeletePreview: throws not_found for missing model", async () => {
  const deps = makeDeps({
    lookupDefinition: () => Promise.resolve(null),
  });

  try {
    await modelDeletePreview(
      createLibSwampContext(),
      deps,
      { modelIdOrName: "missing", force: false },
    );
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "not_found");
  }
});

Deno.test("modelDelete: yields completed after successful deletion", async () => {
  let definitionDeleted = false;
  const deps = makeDeps({
    deleteDefinition: () => {
      definitionDeleted = true;
      return Promise.resolve();
    },
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      force: false,
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "deleting");
  const completed = events[1] as Extract<
    ModelDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.name, "my-model");
  assertEquals(completed.data.type, "aws/s3-bucket");
  assertEquals(definitionDeleted, true);
});

Deno.test("modelDelete: yields error when model referenced by workflows", async () => {
  const deps = makeDeps({
    findAllWorkflows: () =>
      Promise.resolve([
        {
          name: "deploy",
          jobs: [{
            steps: [{
              task: {
                isModelMethod: () => true,
                data: { type: "model_method", modelIdOrName: "my-model" },
              },
            }],
          }],
        },
      ] as unknown as import("../../domain/workflows/workflow.ts").Workflow[]),
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      force: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelDeleteEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("modelDelete: yields error when data exists without force", async () => {
  const deps = makeDeps({
    findDataArtifacts: () => Promise.resolve([{ name: "data1" }]),
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      force: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelDeleteEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("modelDelete: force deletes data artifacts", async () => {
  let dataDeletedCount = 0;
  const deps = makeDeps({
    findDataArtifacts: () => Promise.resolve([{ name: "d1" }, { name: "d2" }]),
    deleteData: () => {
      dataDeletedCount++;
      return Promise.resolve();
    },
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      force: true,
    }),
  );

  const completed = events[events.length - 1] as Extract<
    ModelDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.dataDeleted, true);
  assertEquals(dataDeletedCount, 2);
});

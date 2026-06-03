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
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  dataGet,
  type DataGetDeps,
  type DataGetEvent,
  type DataItem,
  type WorkflowDataItemInfo,
} from "./get.ts";

function makeModelType(): ModelType {
  return ModelType.create("model/type");
}

function makeDataItem(): DataItem {
  return {
    id: "data-1",
    name: "output",
    version: 1,
    contentType: "application/json",
    lifetime: "run",
    garbageCollection: "none",
    streaming: false,
    tags: {},
    ownerDefinition: {
      ownerType: "model",
      ownerRef: "def-1",
    },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    size: 42,
    checksum: "abc123",
  };
}

function makeDefinition(): Definition {
  return Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
}

function makeDeps(
  overrides: Partial<DataGetDeps> = {},
): DataGetDeps {
  const modelType = makeModelType();
  const definition = makeDefinition();
  const dataItem = makeDataItem();

  return {
    lookupDefinition: () => Promise.resolve({ definition, type: modelType }),
    findWorkflow: () => Promise.resolve({ id: "wf-1", name: "wf" }),
    findWorkflowRun: () => Promise.resolve({ id: "run-1" }),
    findDataByName: () => Promise.resolve(dataItem),
    findDataInWorkflowRun: () => {
      const info: WorkflowDataItemInfo = {
        data: dataItem,
        modelType,
        modelId: definition.id,
        modelName: definition.name,
        contentPath: "/abs/path/to/data",
      };
      return Promise.resolve(info);
    },
    getContent: () => Promise.resolve(null),
    getContentPath: () => "/abs/path/to/data",
    toRelativePath: (_repoDir, absolutePath) => absolutePath,
    ...overrides,
  };
}

Deno.test("dataGet yields resolving then completed for model-scoped happy path", async () => {
  const deps = makeDeps();
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      dataName: "output",
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<DataGetEvent, { kind: "completed" }>;
  assertEquals(completed.data.name, "output");
  assertEquals(completed.data.modelName, "my-model");
});

Deno.test("dataGet yields error with validation_failed when dataName missing for model-scoped", async () => {
  const deps = makeDeps();
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<DataGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("dataGet yields error with validation_failed when no model or workflow", async () => {
  const deps = makeDeps();
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<DataGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("dataGet yields resolving then completed for workflow-scoped happy path", async () => {
  const deps = makeDeps();
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      workflowName: "wf",
      dataName: "result",
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<DataGetEvent, { kind: "completed" }>;
  assertEquals(completed.data.name, "output");
});

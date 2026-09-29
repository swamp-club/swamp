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

import { assertEquals, assertRejects } from "@std/assert";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createDataListDeps,
  dataList,
  type DataListData,
  type DataListDeps,
  type DataListEvent,
  type WorkflowDataListData,
} from "./list.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";

function makeDeps(overrides?: Partial<DataListDeps>): DataListDeps {
  const definition = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
  const modelType = ModelType.create("aws/ec2");
  return {
    lookupDefinition: () => Promise.resolve({ definition, type: modelType }),
    findAllForModel: () =>
      Promise.resolve([
        {
          id: "d1",
          name: "output",
          version: 1,
          contentType: "application/json",
          type: "data",
          streaming: false,
          size: 100,
          createdAt: new Date("2026-01-01"),
        },
        {
          id: "d2",
          name: "run.log",
          version: 1,
          contentType: "text/plain",
          type: "log",
          streaming: false,
          size: 50,
          createdAt: new Date("2026-01-01"),
        },
      ]),
    findWorkflow: () => Promise.resolve({ id: "wf-1", name: "my-workflow" }),
    findWorkflowRun: () =>
      Promise.resolve({ id: "run-1", status: "completed" }),
    findLatestRun: () => Promise.resolve({ id: "run-1", status: "completed" }),
    findAllForWorkflowRun: (_workflowId: string, _runId: string) =>
      Promise.resolve([
        {
          data: {
            id: "d1",
            name: "output",
            version: 1,
            contentType: "application/json",
            type: "data",
            streaming: false,
            size: 100,
            createdAt: new Date("2026-01-01"),
          },
          modelId: definition.id,
          modelName: definition.name,
          modelType,
          jobName: "job1",
          stepName: "step1",
        },
      ]),
    ...overrides,
  };
}

Deno.test("dataList model-scoped yields grouped data", async () => {
  const deps = makeDeps();
  const events = await collect<DataListEvent>(
    dataList(createLibSwampContext(), deps, { modelIdOrName: "my-model" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    DataListEvent,
    { kind: "completed" }
  >;
  const data = completed.data as DataListData;
  assertEquals(data.total, 2);
  // log type should come before data type (standard ordering)
  assertEquals(data.groups[0].type, "log");
  assertEquals(data.groups[1].type, "data");
});

Deno.test("dataList workflow-scoped yields grouped data", async () => {
  const deps = makeDeps();
  const events = await collect<DataListEvent>(
    dataList(createLibSwampContext(), deps, { workflowName: "my-workflow" }),
  );

  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    DataListEvent,
    { kind: "completed" }
  >;
  const data = completed.data as WorkflowDataListData;
  assertEquals(data.workflowName, "my-workflow");
  assertEquals(data.total, 1);
});

Deno.test("dataList yields error when both model and workflow given", async () => {
  const deps = makeDeps();
  const events = await collect<DataListEvent>(
    dataList(createLibSwampContext(), deps, {
      modelIdOrName: "m",
      workflowName: "w",
    }),
  );

  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<DataListEvent, { kind: "error" }>;
  assertEquals(error.error.code, "validation_failed");
});

Deno.test("dataList yields error when neither model nor workflow given", async () => {
  const deps = makeDeps();
  const events = await collect<DataListEvent>(
    dataList(createLibSwampContext(), deps, {}),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test("dataList yields error when model not found", async () => {
  const deps = makeDeps({
    lookupDefinition: () => Promise.resolve(null),
  });
  const events = await collect<DataListEvent>(
    dataList(createLibSwampContext(), deps, { modelIdOrName: "missing" }),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test(
  "createDataListDeps: uses injectedDefinitionRepo for lookups",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
    try {
      const injected = new YamlDefinitionRepository(dir);
      const deps = createDataListDeps(
        dir,
        undefined,
        undefined,
        undefined,
        undefined,
        injected,
      );
      const result = await deps.lookupDefinition("nonexistent");
      assertEquals(result, null);
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    }
  },
);

Deno.test("dataList: byId resolves the model by id only, never by name", async () => {
  const definition = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
  const byIdLookups: string[] = [];
  const listedFor: string[] = [];
  const base = makeDeps();
  const deps = makeDeps({
    lookupDefinition: () => {
      throw new Error("name-first lookup must not be used with byId");
    },
    lookupDefinitionById: (id) => {
      byIdLookups.push(id);
      return Promise.resolve({
        definition,
        type: ModelType.create("aws/ec2"),
      });
    },
    findAllForModel: (type, definitionId) => {
      listedFor.push(definitionId);
      return base.findAllForModel(type, definitionId);
    },
  });
  const events = await collect<DataListEvent>(
    dataList(createLibSwampContext(), deps, {
      modelIdOrName: definition.id,
      byId: true,
    }),
  );

  assertEquals(events[1].kind, "completed");
  assertEquals(byIdLookups, [definition.id]);
  assertEquals(listedFor, [definition.id]);
});

Deno.test("dataList: byId without a by-id lookup fails instead of looking up by name", async () => {
  let nameLookups = 0;
  const deps = makeDeps({
    lookupDefinition: () => {
      nameLookups++;
      return Promise.resolve({
        definition: Definition.create({
          id: "00000000-0000-4000-8000-000000000002",
          name: "00000000-0000-4000-8000-000000000001",
          version: 1,
        }),
        type: ModelType.create("aws/ec2"),
      });
    },
  });
  await assertRejects(
    () =>
      collect<DataListEvent>(
        dataList(createLibSwampContext(), deps, {
          modelIdOrName: "00000000-0000-4000-8000-000000000001",
          byId: true,
        }),
      ),
    Error,
    "by-id lookup was requested but none is wired",
  );
  assertEquals(nameLookups, 0);
});

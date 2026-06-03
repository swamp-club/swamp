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
  dataList,
  type DataListData,
  type DataListDeps,
  type DataListEvent,
  type WorkflowDataListData,
} from "./list.ts";

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

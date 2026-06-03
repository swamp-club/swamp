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
  isModelEvaluateAllData,
  modelEvaluate,
  type ModelEvaluateAllData,
  type ModelEvaluateDeps,
  type ModelEvaluateEvent,
  type ModelEvaluateItemData,
} from "./evaluate.ts";

function makeDeps(
  overrides?: Partial<ModelEvaluateDeps>,
): ModelEvaluateDeps {
  const definition = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
  const modelType = ModelType.create("aws/ec2");

  return {
    lookupDefinition: () => Promise.resolve({ definition, type: modelType }),
    evaluateDefinition: () =>
      Promise.resolve({
        definition,
        type: modelType,
        hadExpressions: true,
      }),
    evaluateAllDefinitions: () =>
      Promise.resolve([{
        definition,
        type: modelType,
        hadExpressions: true,
      }]),
    saveEvaluatedDefinition: () => Promise.resolve(),
    getEvaluatedPath: (type, id) =>
      `/tmp/.swamp/definitions-evaluated/${type.normalized}/${id}.yaml`,
    ...overrides,
  };
}

Deno.test("modelEvaluate single model yields evaluating then completed", async () => {
  const deps = makeDeps();
  const events = await collect<ModelEvaluateEvent>(
    modelEvaluate(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "evaluating" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelEvaluateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as ModelEvaluateItemData;
  assertEquals(data.hadExpressions, true);
  assertEquals(data.name, "my-model");
  assertEquals(data.type, "aws/ec2");
  assertEquals(typeof data.outputPath, "string");
});

Deno.test("modelEvaluate single model not found yields error", async () => {
  const deps = makeDeps({
    lookupDefinition: () => Promise.resolve(null),
  });
  const events = await collect<ModelEvaluateEvent>(
    modelEvaluate(createLibSwampContext(), deps, {
      modelIdOrName: "missing",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<ModelEvaluateEvent, { kind: "error" }>;
  assertEquals(error.error.code, "not_found");
});

Deno.test("modelEvaluate all models yields completed with AllData", async () => {
  const deps = makeDeps();
  const events = await collect<ModelEvaluateEvent>(
    modelEvaluate(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "evaluating" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelEvaluateEvent,
    { kind: "completed" }
  >;
  assertEquals(isModelEvaluateAllData(completed.data), true);
  const data = completed.data as ModelEvaluateAllData;
  assertEquals(data.total, 1);
  assertEquals(data.evaluated, 1);
  assertEquals(data.items.length, 1);
});

Deno.test("isModelEvaluateAllData: returns true for AllData, false for ItemData", () => {
  const allData: ModelEvaluateAllData = {
    items: [],
    total: 0,
    evaluated: 0,
  };
  assertEquals(isModelEvaluateAllData(allData), true);

  const itemData: ModelEvaluateItemData = {
    id: "test",
    name: "test",
    type: "test",
    hadExpressions: false,
  };
  assertEquals(isModelEvaluateAllData(itemData), false);
});

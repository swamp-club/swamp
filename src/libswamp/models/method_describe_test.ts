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
import { z } from "zod";
import { Definition } from "../../domain/definitions/definition.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  modelMethodDescribe,
  type ModelMethodDescribeDeps,
  type ModelMethodDescribeEvent,
} from "./method_describe.ts";

function makeDefinition(): Definition {
  return Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
}

function makeModelType(): ModelType {
  return ModelType.create("model/type");
}

function makeModelDefinition(): ModelDefinition {
  return {
    type: makeModelType(),
    version: "2026.01.01.1",
    methods: {
      start: {
        description: "A test method",
        arguments: z.object({ name: z.string() }),
        execute: () => Promise.resolve({}),
      },
    },
  };
}

function makeDeps(
  overrides: Partial<ModelMethodDescribeDeps> = {},
): ModelMethodDescribeDeps {
  const definition = makeDefinition();
  const modelType = makeModelType();
  const modelDef = makeModelDefinition();

  return {
    lookupDefinition: () => Promise.resolve({ definition, type: modelType }),
    resolveModelType: () => Promise.resolve(modelDef),
    ...overrides,
  };
}

Deno.test("modelMethodDescribe yields resolving then completed on happy path", async () => {
  const deps = makeDeps();
  const events = await collect<ModelMethodDescribeEvent>(
    modelMethodDescribe(createLibSwampContext(), deps, "my-model", "start"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    ModelMethodDescribeEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.modelName, "my-model");
  assertEquals(completed.data.method.name, "start");
  assertEquals(completed.data.method.description, "A test method");
});

Deno.test("modelMethodDescribe yields error with not_found when model not found", async () => {
  const deps = makeDeps({
    lookupDefinition: () => Promise.resolve(null),
  });
  const events = await collect<ModelMethodDescribeEvent>(
    modelMethodDescribe(
      createLibSwampContext(),
      deps,
      "unknown-model",
      "start",
    ),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<
    ModelMethodDescribeEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("modelMethodDescribe yields error with unknown_method when method does not exist", async () => {
  const deps = makeDeps();
  const events = await collect<ModelMethodDescribeEvent>(
    modelMethodDescribe(
      createLibSwampContext(),
      deps,
      "my-model",
      "nonexistent",
    ),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<
    ModelMethodDescribeEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "unknown_method");
});

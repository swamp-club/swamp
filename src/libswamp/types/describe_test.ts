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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import type { ModelDefinition } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  typeDescribe,
  type TypeDescribeDeps,
  type TypeDescribeEvent,
} from "./describe.ts";

function makeModelType(): ModelType {
  return ModelType.create("model/type");
}

function makeModelDefinition(): ModelDefinition {
  return {
    type: makeModelType(),
    version: "2026.01.01.1",
    methods: {
      start: {
        description: "Start the resource",
        arguments: z.object({ name: z.string() }),
        execute: () => Promise.resolve({}),
      },
    },
  };
}

function makeDeps(
  overrides: Partial<TypeDescribeDeps> = {},
): TypeDescribeDeps {
  const modelDef = makeModelDefinition();

  return {
    resolveModelType: () => Promise.resolve(modelDef),
    ...overrides,
  };
}

Deno.test("typeDescribe yields resolving then completed on happy path", async () => {
  const deps = makeDeps();
  const modelType = makeModelType();
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(createLibSwampContext(), deps, modelType),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    TypeDescribeEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.type.raw, "model/type");
  assertEquals(completed.data.type.normalized, "model/type");
  assertEquals(completed.data.version, "2026.01.01.1");
  assertEquals(completed.data.methods.length, 1);
  assertEquals(completed.data.methods[0].name, "start");
});

Deno.test("typeDescribe yields error with not_found when type not found", async () => {
  const deps = makeDeps({
    resolveModelType: () => Promise.resolve(undefined),
  });
  const unknownType = ModelType.create("unknown/type");
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(createLibSwampContext(), deps, unknownType),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<TypeDescribeEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("typeDescribe error includes extension search hint", async () => {
  const deps = makeDeps({
    resolveModelType: () => Promise.resolve(undefined),
  });
  const unknownType = ModelType.create("@swamp/gcp/oauth2");
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(createLibSwampContext(), deps, unknownType),
  );

  const last = events[1] as Extract<TypeDescribeEvent, { kind: "error" }>;
  assertStringIncludes(last.error.message, "swamp extension search gcp/oauth2");
  assertStringIncludes(
    last.error.message,
    "swamp extension pull @swamp/gcp/oauth2",
  );
});

Deno.test("typeDescribe error derives correct search term for non-namespaced type", async () => {
  const deps = makeDeps({
    resolveModelType: () => Promise.resolve(undefined),
  });
  const unknownType = ModelType.create("docker/run");
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(createLibSwampContext(), deps, unknownType),
  );

  const last = events[1] as Extract<TypeDescribeEvent, { kind: "error" }>;
  assertStringIncludes(last.error.message, "swamp extension search run");
  assertStringIncludes(last.error.message, "swamp extension pull @docker/run");
});

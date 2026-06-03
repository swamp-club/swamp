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
  type GlobalOutputInfo,
  modelOutputGet,
  type ModelOutputGetDeps,
  type ModelOutputGetEvent,
  type OutputInfo,
} from "./output_get.ts";

function makeModelType(): ModelType {
  return ModelType.create("model/type");
}

function makeDefinition(): Definition {
  return Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
}

function makeOutputInfo(): OutputInfo {
  return {
    id: "aaaa1111-0000-4000-8000-000000000001",
    definitionId: "00000000-0000-4000-8000-000000000001",
    methodName: "start",
    status: "succeeded",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:01:00Z"),
    durationMs: 60000,
    retryCount: 0,
    provenance: {
      definitionHash: "abc123",
      modelVersion: "2026.01.01.1",
      triggeredBy: "user",
    },
  };
}

function makeGlobalOutputInfo(): GlobalOutputInfo {
  return {
    output: makeOutputInfo(),
    type: makeModelType(),
  };
}

function makeDeps(
  overrides: Partial<ModelOutputGetDeps> = {},
): ModelOutputGetDeps {
  const definition = makeDefinition();
  const modelType = makeModelType();
  const output = makeOutputInfo();
  const globalOutput = makeGlobalOutputInfo();

  return {
    findAllOutputsGlobal: () => Promise.resolve([globalOutput]),
    findDefinitionByIdOrName: () =>
      Promise.resolve({ definition, type: modelType }),
    findLatestOutputByDefinition: () => Promise.resolve(output),
    findOutputsByDefinition: () => Promise.resolve([output]),
    findDefinitionById: () => Promise.resolve(definition),
    matchByPartialId: (_items, _partialId) => ({
      status: "found",
      match: globalOutput,
    }),
    isPartialId: () => false,
    modelTypes: () => [modelType],
    ...overrides,
  };
}

Deno.test("modelOutputGet yields resolving then completed when looking up by model name", async () => {
  const deps = makeDeps({
    isPartialId: () => false,
  });
  const events = await collect<ModelOutputGetEvent>(
    modelOutputGet(createLibSwampContext(), deps, "my-model"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    ModelOutputGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.methodName, "start");
  assertEquals(completed.data.modelName, "my-model");
});

Deno.test("modelOutputGet yields resolving then completed when looking up by partial ID", async () => {
  const globalOutput = makeGlobalOutputInfo();
  const definition = makeDefinition();
  const deps = makeDeps({
    isPartialId: () => true,
    matchByPartialId: () => ({ status: "found", match: globalOutput }),
    findOutputsByDefinition: () => Promise.resolve([globalOutput.output]),
    findDefinitionById: () => Promise.resolve(definition),
  });
  const events = await collect<ModelOutputGetEvent>(
    modelOutputGet(createLibSwampContext(), deps, "aaaa111"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    ModelOutputGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.methodName, "start");
});

Deno.test("modelOutputGet yields error with not_found when model not found", async () => {
  const deps = makeDeps({
    isPartialId: () => false,
    findDefinitionByIdOrName: () => Promise.resolve(null),
  });
  const events = await collect<ModelOutputGetEvent>(
    modelOutputGet(createLibSwampContext(), deps, "unknown-model"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<ModelOutputGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("modelOutputGet yields error with ambiguous_id on ambiguous partial ID", async () => {
  const globalOutput = makeGlobalOutputInfo();
  const deps = makeDeps({
    isPartialId: () => true,
    matchByPartialId: () => ({
      status: "ambiguous",
      matches: [
        { id: "aaaa1111-0000-4000-8000-000000000001", match: globalOutput },
        { id: "aaaa1112-0000-4000-8000-000000000002", match: globalOutput },
      ],
    }),
  });
  const events = await collect<ModelOutputGetEvent>(
    modelOutputGet(createLibSwampContext(), deps, "aaaa"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<ModelOutputGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "ambiguous_id");
});

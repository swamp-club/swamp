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
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  isModelValidateAllData,
  modelValidate,
  type ModelValidateData,
  type ModelValidateDeps,
  type ModelValidateEvent,
} from "./validate.ts";

function makeDeps(
  overrides?: Partial<ModelValidateDeps>,
): ModelValidateDeps {
  const definition = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
  const modelType = ModelType.create("aws/ec2");
  return {
    lookupDefinition: () => Promise.resolve({ definition, type: modelType }),
    findAllDefinitions: () =>
      Promise.resolve([{ definition, type: modelType }]),
    resolveModelType: () => Promise.resolve({}),
    validateModel: () =>
      Promise.resolve([
        { name: "schema", passed: true },
        { name: "refs", passed: true },
      ]),
    ...overrides,
  };
}

Deno.test("modelValidate single model yields completed with passed=true", async () => {
  const deps = makeDeps();
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as ModelValidateData;
  assertEquals(data.passed, true);
  assertEquals(data.validations.length, 2);
});

Deno.test("modelValidate single model yields completed with passed=false", async () => {
  const deps = makeDeps({
    validateModel: () =>
      Promise.resolve([
        { name: "schema", passed: false, error: "invalid field" },
      ]),
  });
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
    }),
  );

  const completed = events[1] as Extract<
    ModelValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as ModelValidateData;
  assertEquals(data.passed, false);
});

Deno.test("modelValidate all models yields aggregate results", async () => {
  const deps = makeDeps();
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {}),
  );

  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelValidateEvent,
    { kind: "completed" }
  >;
  assertEquals(isModelValidateAllData(completed.data), true);
});

Deno.test("modelValidate yields error when model not found", async () => {
  const deps = makeDeps({
    lookupDefinition: () => Promise.resolve(null),
  });
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {
      modelIdOrName: "missing",
    }),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test("modelValidate all yields error when no models exist", async () => {
  const deps = makeDeps({
    findAllDefinitions: () => Promise.resolve([]),
  });
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {}),
  );

  assertEquals(events[1].kind, "error");
});

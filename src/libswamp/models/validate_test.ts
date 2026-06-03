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
      Promise.resolve({
        results: [
          { name: "schema", passed: true },
          { name: "refs", passed: true },
        ],
        warnings: [],
      }),
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
      Promise.resolve({
        results: [
          { name: "schema", passed: false, error: "invalid field" },
        ],
        warnings: [],
      }),
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

Deno.test("modelValidate single model resolves all model types for cross-type references", async () => {
  const targetType = ModelType.create("@keeb/mms/dedup");
  const otherType = ModelType.create("@keeb/mms/organizer");
  const targetDef = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "dedup",
    version: 1,
  });
  const otherDef = Definition.create({
    id: "00000000-0000-4000-8000-000000000002",
    name: "organizer",
    version: 1,
  });

  const resolvedTypes: string[] = [];
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: targetDef, type: targetType }),
    findAllDefinitions: () =>
      Promise.resolve([
        { definition: targetDef, type: targetType },
        { definition: otherDef, type: otherType },
      ]),
    resolveModelType: (type) => {
      resolvedTypes.push(type.normalized);
      return Promise.resolve({});
    },
  });

  await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {
      modelIdOrName: "dedup",
    }),
  );

  // The target type is resolved once for the target model, then all types
  // (including the target again) are resolved to populate the registry
  assertEquals(resolvedTypes.includes(targetType.normalized), true);
  assertEquals(resolvedTypes.includes(otherType.normalized), true);
});

Deno.test("modelValidate single model propagates warnings", async () => {
  const deps = makeDeps({
    validateModel: () =>
      Promise.resolve({
        results: [{ name: "schema", passed: true }],
        warnings: [
          {
            name: "Environment variables detected",
            message: "Data stored under this model will vary",
            envVars: [
              { path: "globalArguments.baseUrl", envVar: "BASE_URL" },
            ],
          },
        ],
      }),
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
  assertEquals(data.passed, true);
  assertEquals(data.warnings.length, 1);
  assertEquals(data.warnings[0].name, "Environment variables detected");
  assertEquals(data.warnings[0].envVars?.length, 1);
  assertEquals(data.warnings[0].envVars?.[0].envVar, "BASE_URL");
});

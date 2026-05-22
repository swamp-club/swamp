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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import {
  resolveOrCreateDefinition,
  routeInputsBySchema,
} from "./direct_execution.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";

function createTestModelDef(
  globalArgs?: z.ZodTypeAny,
  methodArgs?: Record<string, z.ZodTypeAny>,
): ModelDefinition {
  const methods: Record<string, {
    description: string;
    arguments: z.ZodTypeAny;
    execute: () => Promise<{ dataHandles: [] }>;
  }> = {};
  for (const [name, args] of Object.entries(methodArgs ?? {})) {
    methods[name] = {
      description: `Test method ${name}`,
      arguments: args,
      execute: () => Promise.resolve({ dataHandles: [] }),
    };
  }
  if (Object.keys(methods).length === 0) {
    methods["run"] = {
      description: "Default test method",
      arguments: z.object({}),
      execute: () => Promise.resolve({ dataHandles: [] }),
    };
  }
  return {
    type: "test/model",
    version: "2026.01.01.1",
    globalArguments: globalArgs,
    methods,
  } as unknown as ModelDefinition;
}

Deno.test("routeInputsBySchema: splits inputs between global and method args", () => {
  const modelDef = createTestModelDef(
    z.object({ region: z.string(), account: z.string() }),
    { run: z.object({ instanceId: z.string() }) },
  );

  const result = routeInputsBySchema(
    { region: "us-east-1", account: "123", instanceId: "i-abc" },
    "run",
    modelDef,
  );

  assertEquals("error" in result, false);
  if (!("error" in result)) {
    assertEquals(result.globalArguments, {
      region: "us-east-1",
      account: "123",
    });
    assertEquals(result.methodArguments, { instanceId: "i-abc" });
  }
});

Deno.test("routeInputsBySchema: method args take precedence on ambiguous keys", () => {
  const modelDef = createTestModelDef(
    z.object({ name: z.string() }),
    { run: z.object({ name: z.string() }) },
  );

  const result = routeInputsBySchema({ name: "test" }, "run", modelDef);

  assertEquals("error" in result, false);
  if (!("error" in result)) {
    assertEquals(result.methodArguments, { name: "test" });
    assertEquals(result.globalArguments, {});
  }
});

Deno.test("routeInputsBySchema: rejects unknown keys", () => {
  const modelDef = createTestModelDef(
    z.object({ region: z.string() }),
    { run: z.object({ id: z.string() }) },
  );

  const result = routeInputsBySchema(
    { region: "us-east-1", id: "123", bogus: "value" },
    "run",
    modelDef,
  );

  assertEquals("error" in result, true);
  if ("error" in result) {
    assertStringIncludes(result.error.message, "bogus");
    assertStringIncludes(result.error.message, "Unknown input");
  }
});

Deno.test("routeInputsBySchema: returns error for unknown method", () => {
  const modelDef = createTestModelDef(
    z.object({ region: z.string() }),
    { run: z.object({}) },
  );

  const result = routeInputsBySchema({}, "nonexistent", modelDef);

  assertEquals("error" in result, true);
  if ("error" in result) {
    assertStringIncludes(result.error.message, "Unknown method");
  }
});

Deno.test("routeInputsBySchema: handles no global args schema", () => {
  const modelDef = createTestModelDef(
    undefined,
    { run: z.object({ id: z.string() }) },
  );

  const result = routeInputsBySchema({ id: "abc" }, "run", modelDef);

  assertEquals("error" in result, false);
  if (!("error" in result)) {
    assertEquals(result.methodArguments, { id: "abc" });
    assertEquals(result.globalArguments, {});
  }
});

Deno.test("routeInputsBySchema: handles empty inputs", () => {
  const modelDef = createTestModelDef(
    z.object({ region: z.string().optional() }),
    { run: z.object({}) },
  );

  const result = routeInputsBySchema({}, "run", modelDef);

  assertEquals("error" in result, false);
  if (!("error" in result)) {
    assertEquals(result.methodArguments, {});
    assertEquals(result.globalArguments, {});
  }
});

Deno.test("resolveOrCreateDefinition: auto-creates definition with routed globalArgs", async () => {
  const modelDef = createTestModelDef(
    z.object({ region: z.string(), account: z.string() }),
    { deploy: z.object({ target: z.string() }) },
  );
  const resolvedType = ModelType.create("test/deploy");
  let savedDefinition: Definition | null = null;

  const result = await resolveOrCreateDefinition(
    {
      lookupDefinition: () => Promise.resolve(null),
      getModelDef: () => modelDef,
      saveDefinition: (_type, def) => {
        savedDefinition = def;
        return Promise.resolve();
      },
      getDefinitionPath: (_type, id) => `/tmp/models/test/deploy/${id}.yaml`,
    },
    "test/deploy",
    "my-deployer",
    "deploy",
    { region: "us-east-1", account: "123456", target: "prod" },
    resolvedType,
    modelDef,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.created, true);
    assertEquals(result.definition.name, "my-deployer");
    assertEquals(result.routedInputs.globalArguments, {
      region: "us-east-1",
      account: "123456",
    });
    assertEquals(result.routedInputs.methodArguments, { target: "prod" });
    assertEquals(savedDefinition !== null, true);
  }
});

Deno.test("resolveOrCreateDefinition: updates globalArgs when they differ on existing definition", async () => {
  const modelDef = createTestModelDef(
    z.object({ region: z.string() }),
    { run: z.object({ id: z.string() }) },
  );
  const resolvedType = ModelType.create("test/model");
  const existingDef = Definition.create({
    name: "existing-model",
    type: "test/model",
    typeVersion: "2026.01.01.1",
    globalArguments: { region: "us-west-2" },
  });
  let saved = false;

  const result = await resolveOrCreateDefinition(
    {
      lookupDefinition: () =>
        Promise.resolve({
          definition: existingDef,
          type: resolvedType,
        }),
      getModelDef: () => modelDef,
      saveDefinition: () => {
        saved = true;
        return Promise.resolve();
      },
      getDefinitionPath: (_type, id) => `/tmp/models/test/model/${id}.yaml`,
    },
    "test/model",
    "existing-model",
    "run",
    { region: "us-east-1", id: "abc" },
    resolvedType,
    modelDef,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.created, false);
    assertEquals(result.definition.id, existingDef.id);
    assertEquals(
      result.definition.globalArguments as Record<string, unknown>,
      { region: "us-east-1" },
    );
    assertEquals(result.globalArgsUpdated, true);
    assertEquals(saved, true);
  }
});

Deno.test("resolveOrCreateDefinition: does not save when globalArgs match", async () => {
  const modelDef = createTestModelDef(
    z.object({ region: z.string() }),
    { run: z.object({ id: z.string() }) },
  );
  const resolvedType = ModelType.create("test/model");
  const existingDef = Definition.create({
    name: "existing-model",
    type: "test/model",
    typeVersion: "2026.01.01.1",
    globalArguments: { region: "us-east-1" },
  });
  let saved = false;

  const result = await resolveOrCreateDefinition(
    {
      lookupDefinition: () =>
        Promise.resolve({
          definition: existingDef,
          type: resolvedType,
        }),
      getModelDef: () => modelDef,
      saveDefinition: () => {
        saved = true;
        return Promise.resolve();
      },
      getDefinitionPath: (_type, id) => `/tmp/models/test/model/${id}.yaml`,
    },
    "test/model",
    "existing-model",
    "run",
    { region: "us-east-1", id: "abc" },
    resolvedType,
    modelDef,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.created, false);
    assertEquals(result.globalArgsUpdated, false);
    assertEquals(saved, false);
  }
});

Deno.test("resolveOrCreateDefinition: removes stale keys when globalArgs change", async () => {
  const modelDef = createTestModelDef(
    z.object({ region: z.string() }),
    { run: z.object({ id: z.string() }) },
  );
  const resolvedType = ModelType.create("test/model");
  const existingDef = Definition.create({
    name: "existing-model",
    type: "test/model",
    typeVersion: "2026.01.01.1",
    globalArguments: { region: "us-west-2", staleKey: "leftover" },
  });

  const result = await resolveOrCreateDefinition(
    {
      lookupDefinition: () =>
        Promise.resolve({
          definition: existingDef,
          type: resolvedType,
        }),
      getModelDef: () => modelDef,
      saveDefinition: () => Promise.resolve(),
      getDefinitionPath: (_type, id) => `/tmp/models/test/model/${id}.yaml`,
    },
    "test/model",
    "existing-model",
    "run",
    { region: "us-east-1", id: "abc" },
    resolvedType,
    modelDef,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.definition.globalArguments as Record<string, unknown>,
      { region: "us-east-1" },
    );
    assertEquals(result.globalArgsUpdated, true);
  }
});

Deno.test("resolveOrCreateDefinition: rejects type mismatch", async () => {
  const modelDef = createTestModelDef(
    z.object({ region: z.string() }),
    { run: z.object({}) },
  );
  const requestedType = ModelType.create("test/new-type");
  const existingType = ModelType.create("test/old-type");
  const existingDef = Definition.create({
    name: "my-model",
    type: "test/old-type",
    typeVersion: "2026.01.01.1",
  });

  const result = await resolveOrCreateDefinition(
    {
      lookupDefinition: () =>
        Promise.resolve({
          definition: existingDef,
          type: existingType,
        }),
      getModelDef: () => modelDef,
      saveDefinition: () => Promise.resolve(),
      getDefinitionPath: (_type, id) => `/tmp/models/${id}.yaml`,
    },
    "test/new-type",
    "my-model",
    "run",
    {},
    requestedType,
    modelDef,
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "Type mismatch");
    assertStringIncludes(result.error.message, "test/old-type");
  }
});

Deno.test("resolveOrCreateDefinition: succeeds with required globalArgs when none provided (direct exec get)", async () => {
  const modelDef = createTestModelDef(
    z.object({ Bucket: z.string(), PolicyDocument: z.string() }),
    { get: z.object({ identifier: z.string() }) },
  );
  const resolvedType = ModelType.create("test/bucket-policy");
  let savedDefinition: Definition | null = null;

  const result = await resolveOrCreateDefinition(
    {
      lookupDefinition: () => Promise.resolve(null),
      getModelDef: () => modelDef,
      saveDefinition: (_type, def) => {
        savedDefinition = def;
        return Promise.resolve();
      },
      getDefinitionPath: (_type, id) => `/tmp/models/test/${id}.yaml`,
    },
    "test/bucket-policy",
    "policy-lookup",
    "get",
    { identifier: "my-bucket" },
    resolvedType,
    modelDef,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.created, true);
    assertEquals(result.routedInputs.globalArguments, {});
    assertEquals(result.routedInputs.methodArguments, {
      identifier: "my-bucket",
    });
    assertEquals(savedDefinition !== null, true);
  }
});

Deno.test("resolveOrCreateDefinition: still rejects invalid types on provided globalArgs", async () => {
  const modelDef = createTestModelDef(
    z.object({ region: z.string(), account: z.string() }),
    { run: z.object({ id: z.string() }) },
  );
  const resolvedType = ModelType.create("test/typed-model");

  const result = await resolveOrCreateDefinition(
    {
      lookupDefinition: () => Promise.resolve(null),
      getModelDef: () => modelDef,
      saveDefinition: () => Promise.resolve(),
      getDefinitionPath: (_type, id) => `/tmp/models/test/${id}.yaml`,
    },
    "test/typed-model",
    "my-model",
    "run",
    { region: 12345, id: "abc" },
    resolvedType,
    modelDef,
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "Invalid global arguments");
  }
});

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

function makeModelDefinitionWithSpecs(): ModelDefinition {
  return {
    type: makeModelType(),
    version: "2026.01.01.1",
    resources: {
      state: {
        description: "Current state",
        schema: z.object({ phase: z.string() }),
        lifetime: "infinite",
        garbageCollection: 5,
      },
      output: {
        description: "Output data",
        schema: z.object({ result: z.string() }),
        lifetime: "infinite",
        garbageCollection: 5,
      },
    },
    methods: {
      start: {
        description: "Start the resource",
        arguments: z.object({ name: z.string() }),
        execute: () => Promise.resolve({}),
      },
      stop: {
        description: "Stop the resource",
        arguments: z.object({}),
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

Deno.test("typeDescribe reports each method's kind and where it came from", async () => {
  const modelDef: ModelDefinition = {
    type: makeModelType(),
    version: "2026.01.01.1",
    methods: {
      probe: {
        description: "Probe the resource",
        kind: "read",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
      delete: {
        description: "Delete the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
      sync: {
        description: "Sync the resource",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  };
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(
      createLibSwampContext(),
      makeDeps({ resolveModelType: () => Promise.resolve(modelDef) }),
      makeModelType(),
    ),
  );

  const completed = events[1] as Extract<
    TypeDescribeEvent,
    { kind: "completed" }
  >;
  const byName = Object.fromEntries(
    completed.data.methods.map((m) => [m.name, m]),
  );
  assertEquals(byName.probe.kind, "read");
  assertEquals(byName.probe.kindSource, "declared");
  assertEquals(byName.delete.kind, "delete");
  assertEquals(byName.delete.kindSource, "inferred");
  assertEquals("kind" in byName.sync, false);
  assertEquals(byName.sync.kindSource, "none");
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

Deno.test("typeDescribe: dataOutputSpecs are at type level, not per-method", async () => {
  const modelDef = makeModelDefinitionWithSpecs();
  const deps = makeDeps({
    resolveModelType: () => Promise.resolve(modelDef),
  });
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(createLibSwampContext(), deps, makeModelType()),
  );

  const completed = events[1] as Extract<
    TypeDescribeEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.dataOutputSpecs?.length, 2);
  assertEquals(completed.data.dataOutputSpecs?.[0].specName, "state");
  assertEquals(completed.data.dataOutputSpecs?.[1].specName, "output");
  for (const method of completed.data.methods) {
    assertEquals(Object.keys(method).sort(), [
      "arguments",
      "description",
      "kindSource",
      "name",
    ]);
  }
});

Deno.test("typeDescribe: methods have no inputs or dataOutputSpecs fields", async () => {
  const deps = makeDeps();
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(createLibSwampContext(), deps, makeModelType()),
  );

  const completed = events[1] as Extract<
    TypeDescribeEvent,
    { kind: "completed" }
  >;
  const method = completed.data.methods[0];
  assertEquals("inputs" in method, false);
  assertEquals("dataOutputSpecs" in method, false);
});

Deno.test("typeDescribe: dataOutputSpecs is undefined when type has no specs", async () => {
  const deps = makeDeps();
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(createLibSwampContext(), deps, makeModelType()),
  );

  const completed = events[1] as Extract<
    TypeDescribeEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.dataOutputSpecs, undefined);
});

Deno.test("typeDescribe: Zod v3 method arguments surface upgrade diagnostic", async () => {
  const v3ArgsSchema = {
    _def: {
      typeName: "ZodObject",
      shape: () => ({
        clusterId: { _def: { typeName: "ZodString" } },
        namespace: { _def: { typeName: "ZodString" } },
      }),
    },
  } as unknown as z.ZodTypeAny;

  const modelDef: ModelDefinition = {
    type: makeModelType(),
    version: "1.0.0",
    methods: {
      probe: {
        description: "Probe the cluster",
        arguments: v3ArgsSchema,
        execute: () => Promise.resolve({}),
      },
    },
  };

  const deps = makeDeps({
    resolveModelType: () => Promise.resolve(modelDef),
  });

  const events = await collect<TypeDescribeEvent>(
    typeDescribe(createLibSwampContext(), deps, makeModelType()),
  );

  const completed = events[1] as Extract<
    TypeDescribeEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");

  const args = completed.data.methods[0].arguments as Record<string, unknown>;
  assertEquals(args.$error, "unsupported_zod_version");
  assertStringIncludes(args.message as string, "Zod v3");
  assertStringIncludes(args.message as string, "Upgrade to Zod v4");
});

Deno.test("typeDescribe: an installed extension's name suggests the type it provides instead of a registry search (swamp-club#3819)", async () => {
  const asked: string[] = [];
  const deps = makeDeps({
    resolveModelType: () => Promise.resolve(undefined),
    typesProvidedByExtension: (name) => {
      asked.push(name);
      return ["@swamp/vercel/deployments/deployments"];
    },
  });
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(
      createLibSwampContext(),
      deps,
      ModelType.create("@swamp/vercel/deployments"),
    ),
  );

  const last = events[1] as Extract<TypeDescribeEvent, { kind: "error" }>;
  assertEquals(last.error.code, "not_found");
  assertEquals(asked, ["@swamp/vercel/deployments"]);
  assertStringIncludes(
    last.error.message,
    "not found: @swamp/vercel/deployments\n\n" +
      "Did you mean @swamp/vercel/deployments/deployments? " +
      "(provided by installed extension @swamp/vercel/deployments)",
  );
  assertEquals(last.error.message.includes("swamp extension search"), false);
  assertEquals(last.error.message.includes("swamp extension pull"), false);
});

Deno.test("typeDescribe: an installed extension with several types lists them all, also when typed without @ (swamp-club#3819)", async () => {
  const deps = makeDeps({
    resolveModelType: () => Promise.resolve(undefined),
    typesProvidedByExtension: (name) =>
      name === "@swamp/aws/ec2"
        ? ["@swamp/aws/ec2/instance", "@swamp/aws/ec2/vpc"]
        : [],
  });
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(
      createLibSwampContext(),
      deps,
      ModelType.create("swamp/aws/ec2"),
    ),
  );

  const last = events[1] as Extract<TypeDescribeEvent, { kind: "error" }>;
  assertStringIncludes(
    last.error.message,
    "Did you mean one of these types provided by installed extension @swamp/aws/ec2?\n" +
      "  @swamp/aws/ec2/instance\n" +
      "  @swamp/aws/ec2/vpc",
  );
  assertEquals(last.error.message.includes("swamp extension search"), false);
});

Deno.test("typeDescribe: a name no installed extension matches keeps the registry hint (swamp-club#3819)", async () => {
  const deps = makeDeps({
    resolveModelType: () => Promise.resolve(undefined),
    typesProvidedByExtension: () => [],
  });
  const events = await collect<TypeDescribeEvent>(
    typeDescribe(
      createLibSwampContext(),
      deps,
      ModelType.create("@swamp/gcp/oauth2"),
    ),
  );

  const last = events[1] as Extract<TypeDescribeEvent, { kind: "error" }>;
  assertStringIncludes(last.error.message, "swamp extension search gcp/oauth2");
  assertEquals(last.error.message.includes("Did you mean"), false);
});

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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  modelCreate,
  type ModelCreateDeps,
  type ModelCreateEvent,
} from "./create.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";

function makeDeps(overrides: Partial<ModelCreateDeps> = {}): ModelCreateDeps {
  return {
    resolveModelType: () =>
      Promise.resolve({
        type: { normalized: "aws/s3-bucket" },
        methods: {},
        resources: {},
      } as unknown as Awaited<
        ReturnType<ModelCreateDeps["resolveModelType"]>
      >),
    findByNameGlobal: () => Promise.resolve(false),
    getModelDef: () => undefined,
    createAndSave: () =>
      Promise.resolve({
        id: "def-1",
        name: "my-model",
      } as unknown as Awaited<
        ReturnType<ModelCreateDeps["createAndSave"]>
      >),
    getPath: () => "/repo/models/my-model/definition.yaml",
    listAvailableTypes: () => ["aws/s3-bucket", "swamp/echo"],
    ...overrides,
  };
}

Deno.test("modelCreate: yields completed on successful creation", async () => {
  const deps = makeDeps();

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "aws/s3-bucket",
      name: "my-model",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "creating" });
  const completed = events[1] as Extract<
    ModelCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.id, "def-1");
  assertEquals(completed.data.name, "my-model");
  assertEquals(completed.data.type, "aws/s3-bucket");
  assertEquals(completed.data.path, "/repo/models/my-model/definition.yaml");
});

Deno.test("modelCreate: yields error for unknown model type", async () => {
  const deps = makeDeps({
    resolveModelType: () => Promise.resolve(undefined),
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "unknown/type",
      name: "my-model",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "creating" });
  const last = events[1] as Extract<ModelCreateEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("modelCreate: coerces string global arguments to match schema types", async () => {
  const globalArgsSchema = z.object({
    repo: z.string(),
    issueNumber: z.number(),
  });

  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/typed-args" },
      version: "1.0.0",
      globalArguments: globalArgsSchema,
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
    createAndSave: (_type, _name, _version, globalArguments) => {
      // Verify the number was coerced from string "428" to number 428
      assertEquals(
        (globalArguments as Record<string, unknown>)?.issueNumber,
        428,
      );
      return Promise.resolve({
        id: "def-1",
        name: "my-model",
      } as unknown as Awaited<
        ReturnType<ModelCreateDeps["createAndSave"]>
      >);
    },
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/typed-args",
      name: "my-model",
      // CLI passes all values as strings from --global-arg key=value
      globalArguments: { repo: "owner/repo", issueNumber: "428" },
    }),
  );

  const completed = events[events.length - 1] as Extract<
    ModelCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
});

Deno.test("modelCreate: yields error when unknown global arg key is passed", async () => {
  const globalArgsSchema = z.object({
    name: z.string(),
  });

  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/strict" },
      version: "1.0.0",
      globalArguments: globalArgsSchema,
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/strict",
      name: "my-model",
      globalArguments: { name: "hello", typoKey: "whatever" },
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "creating" });
  const last = events[1] as Extract<ModelCreateEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("modelCreate: accepts all known global arg keys", async () => {
  const globalArgsSchema = z.object({
    name: z.string(),
    count: z.number(),
  });

  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/strict" },
      version: "1.0.0",
      globalArguments: globalArgsSchema,
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
    createAndSave: () =>
      Promise.resolve({
        id: "def-1",
        name: "my-model",
      } as unknown as Awaited<
        ReturnType<ModelCreateDeps["createAndSave"]>
      >),
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/strict",
      name: "my-model",
      globalArguments: { name: "hello", count: "3" },
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(last.kind, "completed");
});

Deno.test("modelCreate: rejects prototype-chain key like 'constructor' as global arg", async () => {
  const globalArgsSchema = z.object({ name: z.string() });

  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/strict" },
      version: "1.0.0",
      globalArguments: globalArgsSchema,
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/strict",
      name: "my-model",
      globalArguments: { name: "hello", constructor: "oops" },
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelCreateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertEquals(last.error.message.includes("constructor"), true);
});

Deno.test("modelCreate: rejects unknown global arg when schema uses .refine()", async () => {
  const globalArgsSchema = z.object({ name: z.string() }).refine(
    (v) => v.name.length > 0,
    { message: "name cannot be empty" },
  );

  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/refined" },
      version: "1.0.0",
      globalArguments: globalArgsSchema,
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/refined",
      name: "my-model",
      globalArguments: { name: "hello", typoKey: "oops" },
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelCreateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertEquals(last.error.message.includes("typoKey"), true);
});

Deno.test("modelCreate: yields error when name already exists", async () => {
  const deps = makeDeps({
    findByNameGlobal: () => Promise.resolve(true),
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "aws/s3-bucket",
      name: "existing-model",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "creating" });
  const last = events[1] as Extract<ModelCreateEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "already_exists");
});

Deno.test("modelCreate: coerces string boolean global arguments", async () => {
  const globalArgsSchema = z.object({
    name: z.string(),
    enabled: z.boolean(),
  });

  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/bool-args" },
      version: "1.0.0",
      globalArguments: globalArgsSchema,
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
    createAndSave: (_type, _name, _version, globalArguments) => {
      assertEquals(
        (globalArguments as Record<string, unknown>)?.enabled,
        true,
      );
      return Promise.resolve({
        id: "def-1",
        name: "my-model",
      } as unknown as Awaited<
        ReturnType<ModelCreateDeps["createAndSave"]>
      >);
    },
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/bool-args",
      name: "my-model",
      globalArguments: { name: "test", enabled: "true" },
    }),
  );

  const completed = events[events.length - 1] as Extract<
    ModelCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
});

Deno.test("modelCreate: coerces string values with default-wrapped schema", async () => {
  const globalArgsSchema = z.object({
    cpus: z.number().default(4),
  });

  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/default-args" },
      version: "1.0.0",
      globalArguments: globalArgsSchema,
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
    createAndSave: (_type, _name, _version, globalArguments) => {
      assertEquals(
        (globalArguments as Record<string, unknown>)?.cpus,
        8,
      );
      return Promise.resolve({
        id: "def-1",
        name: "my-model",
      } as unknown as Awaited<
        ReturnType<ModelCreateDeps["createAndSave"]>
      >);
    },
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/default-args",
      name: "my-model",
      globalArguments: { cpus: "8" },
    }),
  );

  const completed = events[events.length - 1] as Extract<
    ModelCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
});

Deno.test("modelCreate: coerces Zod v3-style schema global arguments", async () => {
  // Simulate a Zod v3 schema where _def uses typeName instead of type,
  // and shape is a function instead of a value.
  const v3LikeSchema = {
    _def: {
      typeName: "ZodObject",
      shape: () => ({
        count: {
          _def: {
            typeName: "ZodNumber",
          },
          safeParse: (v: unknown) => {
            if (typeof v === "number") {
              return { success: true, data: v };
            }
            return {
              success: false,
              error: { issues: [{ path: [], message: "expected number" }] },
            };
          },
        },
      }),
    },
    safeParse: (v: unknown) => {
      const obj = v as Record<string, unknown>;
      if (typeof obj.count === "number") {
        return { success: true, data: obj };
      }
      return {
        success: false,
        error: {
          issues: [{
            path: ["count"],
            message: "expected number, received string",
          }],
        },
      };
    },
  };

  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/v3-schema" },
      version: "1.0.0",
      globalArguments: v3LikeSchema,
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
    createAndSave: (_type, _name, _version, globalArguments) => {
      assertEquals(
        (globalArguments as Record<string, unknown>)?.count,
        42,
      );
      return Promise.resolve({
        id: "def-1",
        name: "my-model",
      } as unknown as Awaited<
        ReturnType<ModelCreateDeps["createAndSave"]>
      >);
    },
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/v3-schema",
      name: "my-model",
      globalArguments: { count: "42" },
    }),
  );

  const completed = events[events.length - 1] as Extract<
    ModelCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
});

Deno.test("modelCreate: refuses a literal value for a sensitive global arg and does not persist", async () => {
  let saved = false;
  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/sensitive" },
      version: "1.0.0",
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }),
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
    createAndSave: () => {
      saved = true;
      return Promise.resolve(
        { id: "def-1", name: "my-model" } as unknown as Awaited<
          ReturnType<ModelCreateDeps["createAndSave"]>
        >,
      );
    },
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/sensitive",
      name: "my-model",
      globalArguments: { apiKey: "SUPERSECRET123", region: "us-east-1" },
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelCreateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertStringIncludes(last.error.message, "apiKey");
  assertStringIncludes(last.error.message, "vault.get");
  // Fail-closed: the definition was never created/persisted.
  assertEquals(saved, false);
});

Deno.test("modelCreate: accepts a vault.get expression for a sensitive global arg", async () => {
  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/sensitive" },
      version: "1.0.0",
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }),
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/sensitive",
      name: "my-model",
      globalArguments: {
        apiKey: "${{ vault.get('creds', 'apiKey') }}",
        region: "us-east-1",
      },
    }),
  );

  const completed = events[events.length - 1] as Extract<
    ModelCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
});

Deno.test("modelCreate: accepts a vault.get expression for a CONSTRAINED sensitive field (ADV-3)", async () => {
  // The vault.get sentinel is far shorter than min(20); without stripping
  // expression fields before schema validation this would be wrongly rejected,
  // making the vault remediation impossible.
  const deps = makeDeps({
    getModelDef: () => ({
      type: { normalized: "test/sensitive-constrained" },
      version: "1.0.0",
      globalArguments: z.object({
        apiKey: z.string().min(20).meta({ sensitive: true }),
      }),
      methods: {},
      resources: {},
    } as unknown as ModelDefinition),
  });

  const events = await collect<ModelCreateEvent>(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: "test/sensitive-constrained",
      name: "my-model",
      globalArguments: { apiKey: "${{ vault.get('v', 'k') }}" },
    }),
  );

  const completed = events[events.length - 1] as Extract<
    ModelCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
});

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

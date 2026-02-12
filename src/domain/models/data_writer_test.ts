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
import {
  createFileWriterFactory,
  createResourceWriter,
} from "./data_writer.ts";
import { ModelType } from "./model_type.ts";
import type { ResourceOutputSpec } from "./model.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { generateDataId } from "../data/data_id.ts";

/**
 * Creates a minimal mock UnifiedDataRepository for tag resolution tests.
 */
function createMockRepo(): UnifiedDataRepository {
  return {
    findAllGlobal: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestSymlink: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
  };
}

const modelType = ModelType.create("swamp/test");
const modelId = "test-model-id";

const testResources: Record<string, ResourceOutputSpec> = {
  item: {
    schema: z.object({ value: z.string() }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
};

const testFiles = {
  log: {
    contentType: "text/plain",
    lifetime: "infinite" as const,
    garbageCollection: 10,
  },
};

// --- createResourceWriter tag resolution tests ---

Deno.test("createResourceWriter: definition tags appear on produced data", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev", team: "platform" };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    undefined, // tagOverrides
    undefined, // dataOutputOverrides
    definitionTags,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.tags["env"], "dev");
  assertEquals(handle.tags["team"], "platform");
});

Deno.test("createResourceWriter: spec tags override definition tags for same key", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev" };
  const resourcesWithTags: Record<string, ResourceOutputSpec> = {
    item: {
      schema: z.object({ value: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { env: "staging" },
    },
  };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    resourcesWithTags,
    undefined,
    undefined,
    definitionTags,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.tags["env"], "staging");
});

Deno.test("createResourceWriter: runtime tags override definition and spec tags", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev", team: "platform" };
  const runtimeTags = { env: "prod" };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    undefined,
    undefined,
    definitionTags,
    runtimeTags,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.tags["env"], "prod");
  assertEquals(handle.tags["team"], "platform");
});

Deno.test("createResourceWriter: tagOverrides (workflow) override definition tags", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev" };
  const tagOverrides = { source: "step-output", workflow: "my-wf" };

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    tagOverrides,
    undefined,
    definitionTags,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.tags["env"], "dev");
  assertEquals(handle.tags["source"], "step-output");
  assertEquals(handle.tags["workflow"], "my-wf");
});

Deno.test("createResourceWriter: full tag resolution chain", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev", team: "platform", scope: "def" };
  const tagOverrides = { source: "step-output", scope: "workflow" };
  const runtimeTags = { env: "prod", runId: "123" };
  const dataOutputOverrides = [{
    specName: "item",
    tags: { scope: "override" },
  }];

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
    tagOverrides,
    dataOutputOverrides,
    definitionTags,
    runtimeTags,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  // runtime overrides definition
  assertEquals(handle.tags["env"], "prod");
  // definition tag preserved
  assertEquals(handle.tags["team"], "platform");
  // workflow tag overridden by runtime
  assertEquals(handle.tags["source"], "step-output");
  // runtime tag added
  assertEquals(handle.tags["runId"], "123");
  // dataOutputOverrides has highest priority
  assertEquals(handle.tags["scope"], "override");
});

// --- createFileWriterFactory tag resolution tests ---

Deno.test("createFileWriterFactory: definition tags appear on produced data", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev", team: "platform" };

  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
    undefined,
    undefined,
    undefined, // callbacks
    definitionTags,
  );

  const writer = createFileWriter("log", "test-log");
  const handle = await writer.writeText("log content");
  assertEquals(handle.tags["env"], "dev");
  assertEquals(handle.tags["team"], "platform");
});

Deno.test("createFileWriterFactory: runtime tags override definition tags", async () => {
  const repo = createMockRepo();
  const definitionTags = { env: "dev" };
  const runtimeTags = { env: "prod" };

  const { createFileWriter } = createFileWriterFactory(
    repo,
    modelType,
    modelId,
    testFiles,
    undefined,
    undefined,
    undefined,
    definitionTags,
    runtimeTags,
  );

  const writer = createFileWriter("log", "test-log");
  const handle = await writer.writeText("log content");
  assertEquals(handle.tags["env"], "prod");
});

Deno.test("createResourceWriter: no definition or runtime tags still works", async () => {
  const repo = createMockRepo();

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    testResources,
  );

  const handle = await writeResource("item", "test-item", { value: "hello" });
  assertEquals(handle.tags["type"], "resource");
  assertEquals(handle.tags["specName"], "item");
});

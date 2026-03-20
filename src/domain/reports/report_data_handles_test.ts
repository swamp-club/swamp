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
import { buildReportDataHandles } from "./report_data_handles.ts";
import { Data } from "../data/data.ts";
import { ModelType } from "../models/model_type.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";

function makeData(overrides: {
  name?: string;
  lifecycle?: "active" | "deleted";
  tags?: Record<string, string>;
  contentType?: string;
  size?: number;
}): Data {
  return Data.create({
    name: overrides.name ?? "my-resource",
    contentType: overrides.contentType ?? "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: overrides.tags ?? { type: "resource", specName: "my-spec" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test:run" },
    lifecycle: overrides.lifecycle ?? "active",
    size: overrides.size ?? 42,
  });
}

function makeMockRepo(data: Data[]): UnifiedDataRepository {
  return {
    findAllForModel: () => Promise.resolve(data),
  } as unknown as UnifiedDataRepository;
}

const modelType = ModelType.create("test/model");
const modelId = "def-123";

Deno.test("buildReportDataHandles - maps active data to DataHandle[]", async () => {
  const data = makeData({
    name: "my-resource",
    tags: { type: "resource", specName: "my-spec" },
    contentType: "application/json",
    size: 100,
  });
  const repo = makeMockRepo([data]);

  const handles = await buildReportDataHandles(repo, modelType, modelId);

  assertEquals(handles.length, 1);
  assertEquals(handles[0].name, "my-resource");
  assertEquals(handles[0].specName, "my-spec");
  assertEquals(handles[0].kind, "resource");
  assertEquals(handles[0].version, 1);
  assertEquals(handles[0].size, 100);
  assertEquals(handles[0].metadata.contentType, "application/json");
  assertEquals(handles[0].metadata.lifetime, "infinite");
});

Deno.test("buildReportDataHandles - filters out deleted data", async () => {
  const active = makeData({ name: "active", lifecycle: "active" });
  const deleted = makeData({ name: "deleted", lifecycle: "deleted" });
  const repo = makeMockRepo([active, deleted]);

  const handles = await buildReportDataHandles(repo, modelType, modelId);

  assertEquals(handles.length, 1);
  assertEquals(handles[0].name, "active");
});

Deno.test("buildReportDataHandles - sets kind to file when type tag is file", async () => {
  const data = makeData({
    tags: { type: "file", specName: "my-file" },
  });
  const repo = makeMockRepo([data]);

  const handles = await buildReportDataHandles(repo, modelType, modelId);

  assertEquals(handles[0].kind, "file");
  assertEquals(handles[0].specName, "my-file");
});

Deno.test("buildReportDataHandles - falls back to name when specName tag is missing", async () => {
  const data = makeData({
    name: "fallback-name",
    tags: { type: "resource" },
  });
  const repo = makeMockRepo([data]);

  const handles = await buildReportDataHandles(repo, modelType, modelId);

  assertEquals(handles[0].specName, "fallback-name");
});

Deno.test("buildReportDataHandles - returns empty array when no data exists", async () => {
  const repo = makeMockRepo([]);

  const handles = await buildReportDataHandles(repo, modelType, modelId);

  assertEquals(handles, []);
});

Deno.test("buildReportDataHandles - defaults size to 0 when undefined", async () => {
  const data = Data.create({
    name: "no-size",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test:run" },
  });
  const repo = makeMockRepo([data]);

  const handles = await buildReportDataHandles(repo, modelType, modelId);

  assertEquals(handles[0].size, 0);
});

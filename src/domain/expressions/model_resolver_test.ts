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

import { assertEquals, assertExists } from "@std/assert";
import { DataCache, type DataRecord } from "./model_resolver.ts";

// Test DataCache

Deno.test("DataCache.addData and getVersion retrieves specific version", () => {
  const cache = new DataCache();
  const record: DataRecord = {
    id: "data-123",
    name: "my-data",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: { foo: "bar" },
    tags: { type: "test" },
  };

  cache.addData("my-model", "my-data", 1, record);
  const result = cache.getVersion("my-model", "my-data", 1);

  assertExists(result);
  assertEquals(result.id, "data-123");
  assertEquals(result.version, 1);
  assertEquals(result.attributes.foo, "bar");
});

Deno.test("DataCache.getVersion returns null for missing data", () => {
  const cache = new DataCache();
  const result = cache.getVersion("nonexistent", "data", 1);
  assertEquals(result, null);
});

Deno.test("DataCache.getLatest returns the highest version", () => {
  const cache = new DataCache();

  const v1: DataRecord = {
    id: "data-123",
    name: "my-data",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: { value: 1 },
    tags: { type: "test" },
  };
  const v2: DataRecord = {
    id: "data-123",
    name: "my-data",
    version: 2,
    createdAt: "2024-01-02T00:00:00Z",
    attributes: { value: 2 },
    tags: { type: "test" },
  };
  const v3: DataRecord = {
    id: "data-123",
    name: "my-data",
    version: 3,
    createdAt: "2024-01-03T00:00:00Z",
    attributes: { value: 3 },
    tags: { type: "test" },
  };

  // Add in non-sequential order to test proper max finding
  cache.addData("my-model", "my-data", 2, v2);
  cache.addData("my-model", "my-data", 1, v1);
  cache.addData("my-model", "my-data", 3, v3);

  const result = cache.getLatest("my-model", "my-data");
  assertExists(result);
  assertEquals(result.version, 3);
  assertEquals(result.attributes.value, 3);
});

Deno.test("DataCache.getLatest returns null for missing model", () => {
  const cache = new DataCache();
  const result = cache.getLatest("nonexistent", "data");
  assertEquals(result, null);
});

Deno.test("DataCache.listVersions returns sorted version numbers", () => {
  const cache = new DataCache();

  const v1: DataRecord = {
    id: "data-123",
    name: "my-data",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: {},
    tags: {},
  };
  const v2: DataRecord = {
    id: "data-123",
    name: "my-data",
    version: 2,
    createdAt: "2024-01-02T00:00:00Z",
    attributes: {},
    tags: {},
  };
  const v5: DataRecord = {
    id: "data-123",
    name: "my-data",
    version: 5,
    createdAt: "2024-01-05T00:00:00Z",
    attributes: {},
    tags: {},
  };

  // Add in non-sequential order
  cache.addData("my-model", "my-data", 5, v5);
  cache.addData("my-model", "my-data", 1, v1);
  cache.addData("my-model", "my-data", 2, v2);

  const versions = cache.listVersions("my-model", "my-data");
  assertEquals(versions, [1, 2, 5]);
});

Deno.test("DataCache.listVersions returns empty array for missing data", () => {
  const cache = new DataCache();
  const versions = cache.listVersions("nonexistent", "data");
  assertEquals(versions, []);
});

Deno.test("DataCache.findByTag returns matching records", () => {
  const cache = new DataCache();

  const logRecord1: DataRecord = {
    id: "log-1",
    name: "output-log",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: { message: "hello" },
    tags: { type: "log" },
  };
  const logRecord2: DataRecord = {
    id: "log-2",
    name: "error-log",
    version: 1,
    createdAt: "2024-01-02T00:00:00Z",
    attributes: { message: "error" },
    tags: { type: "log" },
  };
  const dataRecord: DataRecord = {
    id: "data-1",
    name: "config",
    version: 1,
    createdAt: "2024-01-03T00:00:00Z",
    attributes: { key: "value" },
    tags: { type: "config" },
  };

  cache.addData("model-a", "output-log", 1, logRecord1);
  cache.addData("model-b", "error-log", 1, logRecord2);
  cache.addData("model-a", "config", 1, dataRecord);

  const logs = cache.findByTag("type", "log");
  assertEquals(logs.length, 2);
  assertEquals(logs.some((r) => r.id === "log-1"), true);
  assertEquals(logs.some((r) => r.id === "log-2"), true);

  const configs = cache.findByTag("type", "config");
  assertEquals(configs.length, 1);
  assertEquals(configs[0].id, "data-1");
});

Deno.test("DataCache.findByTag returns empty array for no matches", () => {
  const cache = new DataCache();
  const result = cache.findByTag("nonexistent", "tag");
  assertEquals(result, []);
});

Deno.test("DataCache.getDataNames returns all data names for a model", () => {
  const cache = new DataCache();

  const data1: DataRecord = {
    id: "d1",
    name: "data-a",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: {},
    tags: {},
  };
  const data2: DataRecord = {
    id: "d2",
    name: "data-b",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: {},
    tags: {},
  };

  cache.addData("my-model", "data-a", 1, data1);
  cache.addData("my-model", "data-b", 1, data2);

  const names = cache.getDataNames("my-model");
  assertEquals(names.length, 2);
  assertEquals(names.includes("data-a"), true);
  assertEquals(names.includes("data-b"), true);
});

Deno.test("DataCache.getDataNames returns empty array for missing model", () => {
  const cache = new DataCache();
  const names = cache.getDataNames("nonexistent");
  assertEquals(names, []);
});

// DataCache.findBySpec tests

Deno.test("DataCache.findBySpec returns records matching model and specName tag", () => {
  const cache = new DataCache();

  const subnetA: DataRecord = {
    id: "sub-1",
    name: "subnet-a",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: { cidr: "10.0.1.0/24" },
    tags: { type: "resource", specName: "subnet" },
  };
  const subnetB: DataRecord = {
    id: "sub-2",
    name: "subnet-b",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: { cidr: "10.0.2.0/24" },
    tags: { type: "resource", specName: "subnet" },
  };
  const other: DataRecord = {
    id: "other-1",
    name: "vpc",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: {},
    tags: { type: "resource", specName: "vpc" },
  };

  cache.addData("factory-model", "subnet-a", 1, subnetA);
  cache.addData("factory-model", "subnet-b", 1, subnetB);
  cache.addData("factory-model", "vpc", 1, other);

  const results = cache.findBySpec("factory-model", "subnet");
  assertEquals(results.length, 2);
  assertEquals(results.some((r) => r.name === "subnet-a"), true);
  assertEquals(results.some((r) => r.name === "subnet-b"), true);
});

Deno.test("DataCache.findBySpec returns empty array for no matches", () => {
  const cache = new DataCache();
  const results = cache.findBySpec("nonexistent", "spec");
  assertEquals(results, []);
});

Deno.test("DataCache.findBySpec does not mix models", () => {
  const cache = new DataCache();

  const recordA: DataRecord = {
    id: "r1",
    name: "item-a",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: {},
    tags: { specName: "item" },
  };
  const recordB: DataRecord = {
    id: "r2",
    name: "item-b",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: {},
    tags: { specName: "item" },
  };

  cache.addData("model-a", "item-a", 1, recordA);
  cache.addData("model-b", "item-b", 1, recordB);

  assertEquals(cache.findBySpec("model-a", "item").length, 1);
  assertEquals(cache.findBySpec("model-a", "item")[0].name, "item-a");
  assertEquals(cache.findBySpec("model-b", "item").length, 1);
  assertEquals(cache.findBySpec("model-b", "item")[0].name, "item-b");
});

Deno.test("DataCache handles hyphenated model names", () => {
  const cache = new DataCache();
  const record: DataRecord = {
    id: "data-123",
    name: "my-data",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: { foo: "bar" },
    tags: { type: "test" },
  };

  cache.addData("my-hyphenated-model", "my-data", 1, record);
  const result = cache.getVersion("my-hyphenated-model", "my-data", 1);

  assertExists(result);
  assertEquals(result.id, "data-123");
});

Deno.test("DataCache handles multiple data items per model", () => {
  const cache = new DataCache();

  const result1: DataRecord = {
    id: "result-1",
    name: "result",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: { output: "hello" },
    tags: { type: "output" },
  };
  const log1: DataRecord = {
    id: "log-1",
    name: "execution-log",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    attributes: { entries: [] },
    tags: { type: "log" },
  };

  cache.addData("my-model", "result", 1, result1);
  cache.addData("my-model", "execution-log", 1, log1);

  const resultData = cache.getLatest("my-model", "result");
  const logData = cache.getLatest("my-model", "execution-log");

  assertExists(resultData);
  assertExists(logData);
  assertEquals(resultData.name, "result");
  assertEquals(logData.name, "execution-log");
});

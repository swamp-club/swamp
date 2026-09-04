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
import type {
  ModelGetData,
  ModelSearchData,
  ModelSearchItem,
} from "../../libswamp/mod.ts";
import {
  createModelSearchRenderer,
  type ModelPreviewFetcher,
} from "./model_search.tsx";

Deno.test("JsonModelSearchRenderer: single match returns envelope shape", () => {
  const renderer = createModelSearchRenderer("json");
  const handlers = renderer.handlers();

  const items: ModelSearchItem[] = [
    { id: "id-1", name: "unique-model", type: "swamp/echo" },
  ];

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  try {
    const data: ModelSearchData = { query: "unique", results: items };
    handlers.completed({ kind: "completed", data });
  } finally {
    console.log = originalLog;
  }

  assertEquals(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.query, "unique");
  assertEquals(parsed.results.length, 1);
  assertEquals(parsed.results[0].name, "unique-model");
  assertEquals(renderer.selectedItem(), undefined);
});

Deno.test("JsonModelSearchRenderer: multiple matches returns envelope shape", () => {
  const renderer = createModelSearchRenderer("json");
  const handlers = renderer.handlers();

  const items: ModelSearchItem[] = [
    { id: "id-1", name: "model-a", type: "swamp/echo" },
    { id: "id-2", name: "model-b", type: "swamp/echo" },
  ];

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  try {
    const data: ModelSearchData = { query: "model", results: items };
    handlers.completed({ kind: "completed", data });
  } finally {
    console.log = originalLog;
  }

  assertEquals(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.query, "model");
  assertEquals(parsed.results.length, 2);
  assertEquals(renderer.selectedItem(), undefined);
});

Deno.test("JsonModelSearchRenderer: zero matches returns envelope shape", () => {
  const renderer = createModelSearchRenderer("json");
  const handlers = renderer.handlers();

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  try {
    const data: ModelSearchData = { query: "nonexistent", results: [] };
    handlers.completed({ kind: "completed", data });
  } finally {
    console.log = originalLog;
  }

  assertEquals(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.query, "nonexistent");
  assertEquals(parsed.results.length, 0);
  assertEquals(renderer.selectedItem(), undefined);
});

function stubFetchPreview(
  detailMap: Record<string, Partial<ModelGetData>>,
): ModelPreviewFetcher {
  return (item: ModelSearchItem) => {
    const detail = detailMap[item.name];
    if (!detail) return Promise.reject(new Error("not found"));
    return Promise.resolve({
      id: item.id,
      name: item.name,
      type: item.type,
      version: 1,
      tags: {},
      globalArguments: {},
      ...detail,
    } as ModelGetData);
  };
}

Deno.test("JsonModelSearchRenderer: includes methods and globalArgumentsSchema when fetchPreview is provided", async () => {
  const methods = [
    {
      name: "run",
      description: "Execute the model",
      arguments: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ];
  const globalArgumentsSchema = {
    type: "object",
    properties: { timeout: { type: "number" } },
  };
  const fetchPreview = stubFetchPreview({
    "my-model": { methods, globalArgumentsSchema },
  });
  const renderer = createModelSearchRenderer("json", fetchPreview);
  const handlers = renderer.handlers();

  const items: ModelSearchItem[] = [
    { id: "id-1", name: "my-model", type: "swamp/echo" },
  ];

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  try {
    await handlers.completed({
      kind: "completed",
      data: { query: "", results: items },
    });
  } finally {
    console.log = originalLog;
  }

  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.results.length, 1);
  assertEquals(parsed.results[0].methods, methods);
  assertEquals(parsed.results[0].globalArgumentsSchema, globalArgumentsSchema);
});

Deno.test("JsonModelSearchRenderer: deduplicates type resolution across models of the same type", async () => {
  let fetchCount = 0;
  const methods = [
    { name: "run", description: "Run it", arguments: {} },
  ];
  const fetchPreview: ModelPreviewFetcher = (item) => {
    fetchCount++;
    return Promise.resolve({
      id: item.id,
      name: item.name,
      type: item.type,
      version: 1,
      tags: {},
      globalArguments: {},
      methods,
    } as ModelGetData);
  };
  const renderer = createModelSearchRenderer("json", fetchPreview);
  const handlers = renderer.handlers();

  const items: ModelSearchItem[] = [
    { id: "id-1", name: "model-a", type: "swamp/echo" },
    { id: "id-2", name: "model-b", type: "swamp/echo" },
    { id: "id-3", name: "model-c", type: "swamp/echo" },
  ];

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  try {
    await handlers.completed({
      kind: "completed",
      data: { query: "", results: items },
    });
  } finally {
    console.log = originalLog;
  }

  assertEquals(fetchCount, 1);
  const parsed = JSON.parse(logs[0]);
  for (const result of parsed.results) {
    assertEquals(result.methods, methods);
  }
});

Deno.test("JsonModelSearchRenderer: gracefully handles fetchPreview failure", async () => {
  const fetchPreview: ModelPreviewFetcher = () =>
    Promise.reject(new Error("type not found"));
  const renderer = createModelSearchRenderer("json", fetchPreview);
  const handlers = renderer.handlers();

  const items: ModelSearchItem[] = [
    { id: "id-1", name: "broken-model", type: "missing/type" },
  ];

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  try {
    await handlers.completed({
      kind: "completed",
      data: { query: "", results: items },
    });
  } finally {
    console.log = originalLog;
  }

  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.results.length, 1);
  assertEquals(parsed.results[0].name, "broken-model");
  assertEquals(parsed.results[0].methods, undefined);
  assertEquals(parsed.results[0].globalArgumentsSchema, undefined);
});

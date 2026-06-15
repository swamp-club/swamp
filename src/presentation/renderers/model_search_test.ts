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
import type { ModelSearchData, ModelSearchItem } from "../../libswamp/mod.ts";
import { createModelSearchRenderer } from "./model_search.tsx";

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

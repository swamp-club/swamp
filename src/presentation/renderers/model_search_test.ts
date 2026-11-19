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
import { captureLog } from "./search_list_test_helpers.ts";
import type {
  ModelSearchData,
  ModelSearchItem,
} from "../../libswamp/models/search.ts";
import {
  createModelSearchRenderer,
  type ModelPreviewFetcher,
  type ModelSearchFetchers,
  modelSearchPickerLabels,
  type ModelTypeDetailFetcher,
} from "./model_search.tsx";

Deno.test("JsonModelSearchRenderer: single match returns envelope shape", async () => {
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
    await handlers.completed({ kind: "completed", data });
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

Deno.test("JsonModelSearchRenderer: multiple matches returns envelope shape", async () => {
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
    await handlers.completed({ kind: "completed", data });
  } finally {
    console.log = originalLog;
  }

  assertEquals(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.query, "model");
  assertEquals(parsed.results.length, 2);
  assertEquals(renderer.selectedItem(), undefined);
});

Deno.test("JsonModelSearchRenderer: zero matches returns envelope shape", async () => {
  const renderer = createModelSearchRenderer("json");
  const handlers = renderer.handlers();

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  try {
    const data: ModelSearchData = { query: "nonexistent", results: [] };
    await handlers.completed({ kind: "completed", data });
  } finally {
    console.log = originalLog;
  }

  assertEquals(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.query, "nonexistent");
  assertEquals(parsed.results.length, 0);
  assertEquals(renderer.selectedItem(), undefined);
});

async function renderJson(
  fetchers: ModelSearchFetchers,
  items: ModelSearchItem[],
): Promise<{ results: Array<Record<string, unknown>> }> {
  const renderer = createModelSearchRenderer("json", fetchers);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  try {
    await renderer.handlers().completed({
      kind: "completed",
      data: { query: "", results: items },
    });
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(logs[0]);
}

Deno.test("JsonModelSearchRenderer: includes methods and globalArgumentsSchema from the type detail", async () => {
  const methods = [
    {
      name: "run",
      description: "Execute the model",
      arguments: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      kindSource: "none" as const,
    },
  ];
  const globalArgumentsSchema = {
    type: "object",
    properties: { timeout: { type: "number" } },
  };
  const typeDetail: ModelTypeDetailFetcher = (type) =>
    type === "swamp/echo"
      ? Promise.resolve({ methods, globalArgumentsSchema })
      : Promise.reject(new Error("not found"));

  const parsed = await renderJson({ typeDetail }, [
    { id: "id-1", name: "my-model", type: "swamp/echo" },
  ]);

  assertEquals(parsed.results.length, 1);
  assertEquals(parsed.results[0].methods, methods);
  assertEquals(parsed.results[0].globalArgumentsSchema, globalArgumentsSchema);
});

Deno.test("JsonModelSearchRenderer: resolves each distinct type once, by type", async () => {
  const requested: string[] = [];
  const typeDetail: ModelTypeDetailFetcher = (type) => {
    requested.push(type);
    return Promise.resolve({
      methods: [{
        name: type,
        description: "",
        arguments: {},
        kindSource: "none" as const,
      }],
    });
  };

  const parsed = await renderJson({ typeDetail }, [
    { id: "id-1", name: "model-a", type: "swamp/echo" },
    { id: "id-2", name: "model-b", type: "command/shell" },
    { id: "id-3", name: "model-c", type: "swamp/echo" },
  ]);

  assertEquals(requested, ["swamp/echo", "command/shell"]);
  assertEquals(
    parsed.results.map((r) => (r.methods as Array<{ name: string }>)[0].name),
    ["swamp/echo", "command/shell", "swamp/echo"],
  );
});

Deno.test("JsonModelSearchRenderer: never calls the definition preview", async () => {
  let previews = 0;
  const preview: ModelPreviewFetcher = () => {
    previews++;
    return Promise.reject(new Error("unexpected preview"));
  };

  await renderJson({ preview, typeDetail: () => Promise.resolve({}) }, [
    { id: "id-1", name: "model-a", type: "swamp/echo" },
  ]);

  assertEquals(previews, 0);
});

Deno.test("JsonModelSearchRenderer: a type whose detail fails is listed without methods or schema", async () => {
  const typeDetail: ModelTypeDetailFetcher = () =>
    Promise.reject(new Error("type not found"));

  const parsed = await renderJson({ typeDetail }, [
    { id: "id-1", name: "broken-model", type: "missing/type" },
  ]);

  assertEquals(parsed.results.length, 1);
  assertEquals(parsed.results[0].name, "broken-model");
  assertEquals(parsed.results[0].methods, undefined);
  assertEquals(parsed.results[0].globalArgumentsSchema, undefined);
});

Deno.test("modelSearchPickerLabels: the legacy picker keeps its labels and default title", () => {
  assertEquals(modelSearchPickerLabels("model"), {
    itemLabel: "models",
    commandName: undefined,
  });
});

Deno.test("modelSearchPickerLabels: the behavior picker lists behaviors under behavior search", () => {
  assertEquals(modelSearchPickerLabels("behavior"), {
    itemLabel: "behaviors",
    commandName: "behavior search",
  });
});

Deno.test("createModelSearchRenderer: non-interactive log lists matching models under the surface label", async () => {
  const results: ModelSearchItem[] = [
    { id: "id-1", name: "web", type: "command/shell" },
    { id: "id-2", name: "db", type: "swamp/echo" },
  ];
  for (
    const [surface, label] of [["model", "models"], [
      "behavior",
      "behaviors",
    ]] as const
  ) {
    const renderer = createModelSearchRenderer("log", {}, surface, {
      interactive: false,
    });
    const lines = await captureLog(() =>
      renderer.handlers().completed({
        kind: "completed",
        data: { query: "web", results },
      })
    );
    assertEquals(lines, ["web (command/shell)", "", `${label}: 1`]);
    assertEquals(modelSearchPickerLabels(surface).itemLabel, label);
  }
});

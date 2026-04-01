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
import { AutocompleteProvider } from "./autocomplete_provider.ts";
import type { CursorContext } from "./cel_cursor_context.ts";

function makeProvider(
  distinctValues: Record<string, string[]> = {},
  tagKeys: string[] = [],
  tagValues: Record<string, string[]> = {},
): AutocompleteProvider {
  return new AutocompleteProvider(
    (col) => distinctValues[col] ?? [],
    () => tagKeys,
    (key) => tagValues[key] ?? [],
  );
}

Deno.test("AutocompleteProvider: root context returns matching fields", () => {
  const provider = makeProvider();
  const items = provider.complete({ kind: "root", prefix: "model" });
  const labels = items.map((i) => i.label);
  assertEquals(labels.includes("modelName"), true);
  assertEquals(labels.includes("modelType"), true);
  assertEquals(labels.includes("name"), false);
});

Deno.test("AutocompleteProvider: root context with empty prefix returns all fields", () => {
  const provider = makeProvider();
  const items = provider.complete({ kind: "root", prefix: "" });
  // Should include all QUERY_FIELDS
  assertEquals(items.length > 10, true);
  assertEquals(items.every((i) => i.kind === "field"), true);
});

Deno.test("AutocompleteProvider: member context on tags returns tag keys", () => {
  const provider = makeProvider({}, ["env", "team", "region"]);
  const ctx: CursorContext = {
    kind: "member",
    root: "tags",
    chain: [],
    prefix: "e",
  };
  const items = provider.complete(ctx);
  assertEquals(items.length, 1);
  assertEquals(items[0].label, "env");
});

Deno.test("AutocompleteProvider: member context on tags with empty prefix returns all keys", () => {
  const provider = makeProvider({}, ["env", "team"]);
  const ctx: CursorContext = {
    kind: "member",
    root: "tags",
    chain: [],
    prefix: "",
  };
  const items = provider.complete(ctx);
  assertEquals(items.length, 2);
});

Deno.test("AutocompleteProvider: member context on attributes returns empty", () => {
  const provider = makeProvider();
  const ctx: CursorContext = {
    kind: "member",
    root: "attributes",
    chain: [],
    prefix: "st",
  };
  const items = provider.complete(ctx);
  assertEquals(items.length, 0);
});

Deno.test("AutocompleteProvider: operator context returns only comparison operators", () => {
  const provider = makeProvider();
  const items = provider.complete({ kind: "operator", field: "modelName" });
  const labels = items.map((i) => i.label);
  assertEquals(labels.includes("=="), true);
  assertEquals(labels.includes("!="), true);
  assertEquals(labels.includes(">="), true);
  // Dot methods should NOT appear in operator context (space after field)
  assertEquals(labels.includes("contains("), false);
  assertEquals(labels.includes(".contains("), false);
  assertEquals(items.every((i) => i.kind === "operator"), true);
});

Deno.test("AutocompleteProvider: member context on known field returns dot methods", () => {
  const provider = makeProvider();
  const ctx: CursorContext = {
    kind: "member",
    root: "name",
    chain: [],
    prefix: "",
  };
  const items = provider.complete(ctx);
  const labels = items.map((i) => i.label);
  assertEquals(labels.includes("contains("), true);
  assertEquals(labels.includes("startsWith("), true);
  assertEquals(labels.includes("matches("), true);
  // Comparison operators should NOT appear
  assertEquals(labels.includes("=="), false);
});

Deno.test("AutocompleteProvider: member context on known field filters by prefix", () => {
  const provider = makeProvider();
  const ctx: CursorContext = {
    kind: "member",
    root: "name",
    chain: [],
    prefix: "con",
  };
  const items = provider.complete(ctx);
  assertEquals(items.length, 1);
  assertEquals(items[0].label, "contains(");
});

Deno.test("AutocompleteProvider: value context for modelName uses distinct values", () => {
  const provider = makeProvider({
    model_name: ["ingest", "scanner", "config"],
  });
  const items = provider.complete({
    kind: "value",
    field: "modelName",
    operator: "==",
    prefix: "sc",
  });
  assertEquals(items.length, 1);
  assertEquals(items[0].label, '"scanner"');
});

Deno.test("AutocompleteProvider: value context for modelName with empty prefix", () => {
  const provider = makeProvider({
    model_name: ["ingest", "scanner"],
  });
  const items = provider.complete({
    kind: "value",
    field: "modelName",
    operator: "==",
    prefix: "",
  });
  assertEquals(items.length, 2);
});

Deno.test("AutocompleteProvider: value context for streaming returns booleans", () => {
  const provider = makeProvider();
  const items = provider.complete({
    kind: "value",
    field: "streaming",
    operator: "==",
    prefix: "",
  });
  const labels = items.map((i) => i.label);
  assertEquals(labels, ["true", "false"]);
});

Deno.test("AutocompleteProvider: value context for ownerType returns enum values", () => {
  const provider = makeProvider();
  const items = provider.complete({
    kind: "value",
    field: "ownerType",
    operator: "==",
    prefix: "",
  });
  assertEquals(items.length, 3);
  assertEquals(items[0].label, '"model-method"');
});

Deno.test("AutocompleteProvider: value context for tags.env returns tag values", () => {
  const provider = makeProvider({}, [], {
    env: ["prod", "staging", "dev"],
  });
  const items = provider.complete({
    kind: "value",
    field: "tags.env",
    operator: "==",
    prefix: "pr",
  });
  assertEquals(items.length, 1);
  assertEquals(items[0].label, '"prod"');
});

Deno.test("AutocompleteProvider: unknown context returns empty", () => {
  const provider = makeProvider();
  const items = provider.complete({ kind: "unknown" });
  assertEquals(items.length, 0);
});

Deno.test("AutocompleteProvider: caches distinct values", () => {
  let callCount = 0;
  const provider = new AutocompleteProvider(
    (col) => {
      callCount++;
      return col === "model_name" ? ["scanner"] : [];
    },
    () => [],
    () => [],
  );

  provider.complete({
    kind: "value",
    field: "modelName",
    operator: "==",
    prefix: "",
  });
  provider.complete({
    kind: "value",
    field: "modelName",
    operator: "==",
    prefix: "",
  });

  assertEquals(callCount, 1);
});

Deno.test("AutocompleteProvider: caches tag keys", () => {
  let callCount = 0;
  const provider = new AutocompleteProvider(
    () => [],
    () => {
      callCount++;
      return ["env"];
    },
    () => [],
  );

  const ctx: CursorContext = {
    kind: "member",
    root: "tags",
    chain: [],
    prefix: "",
  };
  provider.complete(ctx);
  provider.complete(ctx);

  assertEquals(callCount, 1);
});

Deno.test("AutocompleteProvider: value context for unknown field returns empty", () => {
  const provider = makeProvider();
  const items = provider.complete({
    kind: "value",
    field: "name",
    operator: "==",
    prefix: "",
  });
  assertEquals(items.length, 0);
});

Deno.test("AutocompleteProvider: value context for specName uses distinct values", () => {
  const provider = makeProvider({ spec_name: ["result", "config", "state"] });
  const items = provider.complete({
    kind: "value",
    field: "specName",
    operator: "==",
    prefix: "re",
  });
  assertEquals(items.length, 1);
  assertEquals(items[0].label, '"result"');
});

Deno.test("AutocompleteProvider: root context includes detail with field types", () => {
  const provider = makeProvider();
  const items = provider.complete({ kind: "root", prefix: "size" });
  assertEquals(items.length, 1);
  assertEquals(items[0].detail, "int");
});

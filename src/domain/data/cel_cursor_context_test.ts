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
import { determineCursorContext } from "./cel_cursor_context.ts";

Deno.test("determineCursorContext: empty expression returns root", () => {
  const ctx = determineCursorContext("", 0);
  assertEquals(ctx, { kind: "root", prefix: "" });
});

Deno.test("determineCursorContext: whitespace-only returns root", () => {
  const ctx = determineCursorContext("   ", 3);
  assertEquals(ctx, { kind: "root", prefix: "" });
});

Deno.test("determineCursorContext: typing a field name at start", () => {
  const ctx = determineCursorContext("model", 5);
  assertEquals(ctx, { kind: "root", prefix: "model" });
});

Deno.test("determineCursorContext: typing a field name after &&", () => {
  const ctx = determineCursorContext('modelName == "scanner" && spec', 30);
  assertEquals(ctx, { kind: "root", prefix: "spec" });
});

Deno.test("determineCursorContext: typing a field name after ||", () => {
  const ctx = determineCursorContext("a == 1 || name", 14);
  assertEquals(ctx, { kind: "root", prefix: "name" });
});

Deno.test("determineCursorContext: typing after opening paren", () => {
  const ctx = determineCursorContext("(model", 6);
  assertEquals(ctx, { kind: "root", prefix: "model" });
});

Deno.test("determineCursorContext: space after paren returns root", () => {
  const ctx = determineCursorContext("( ", 2);
  assertEquals(ctx, { kind: "root", prefix: "" });
});

Deno.test("determineCursorContext: operator context after field name", () => {
  const ctx = determineCursorContext("modelName ", 10);
  assertEquals(ctx, { kind: "operator", field: "modelName" });
});

Deno.test("determineCursorContext: operator context after dotted field", () => {
  const ctx = determineCursorContext("tags.env ", 9);
  assertEquals(ctx, { kind: "operator", field: "tags.env" });
});

Deno.test("determineCursorContext: member access on tags", () => {
  const ctx = determineCursorContext("tags.en", 7);
  assertEquals(ctx, {
    kind: "member",
    root: "tags",
    chain: [],
    prefix: "en",
  });
});

Deno.test("determineCursorContext: member access on tags with empty prefix", () => {
  const ctx = determineCursorContext("tags.", 5);
  assertEquals(ctx, {
    kind: "member",
    root: "tags",
    chain: [],
    prefix: "",
  });
});

Deno.test("determineCursorContext: member access on attributes", () => {
  const ctx = determineCursorContext("attributes.stat", 15);
  assertEquals(ctx, {
    kind: "member",
    root: "attributes",
    chain: [],
    prefix: "stat",
  });
});

Deno.test("determineCursorContext: nested member access", () => {
  const ctx = determineCursorContext("attributes.network.vpc", 22);
  assertEquals(ctx, {
    kind: "member",
    root: "attributes",
    chain: ["network"],
    prefix: "vpc",
  });
});

Deno.test("determineCursorContext: dot on known field is member context", () => {
  const ctx = determineCursorContext("name.con", 8);
  assertEquals(ctx, {
    kind: "member",
    root: "name",
    chain: [],
    prefix: "con",
  });
});

Deno.test("determineCursorContext: value context after ==", () => {
  const ctx = determineCursorContext('modelName == "scan', 18);
  assertEquals(ctx, {
    kind: "value",
    field: "modelName",
    operator: "==",
    prefix: "scan",
  });
});

Deno.test("determineCursorContext: value context after == with empty prefix", () => {
  const ctx = determineCursorContext("modelName == ", 13);
  assertEquals(ctx, {
    kind: "value",
    field: "modelName",
    operator: "==",
    prefix: "",
  });
});

Deno.test("determineCursorContext: value context after !=", () => {
  const ctx = determineCursorContext('dataType != "log', 16);
  assertEquals(ctx, {
    kind: "value",
    field: "dataType",
    operator: "!=",
    prefix: "log",
  });
});

Deno.test("determineCursorContext: value context after >", () => {
  const ctx = determineCursorContext("size > 10", 9);
  assertEquals(ctx, {
    kind: "value",
    field: "size",
    operator: ">",
    prefix: "10",
  });
});

Deno.test("determineCursorContext: value context after >= with space", () => {
  const ctx = determineCursorContext("version >= ", 11);
  assertEquals(ctx, {
    kind: "value",
    field: "version",
    operator: ">=",
    prefix: "",
  });
});

Deno.test("determineCursorContext: root context after && with space", () => {
  const expr = 'modelName == "scanner" && ';
  const ctx = determineCursorContext(expr, expr.length);
  assertEquals(ctx, { kind: "root", prefix: "" });
});

Deno.test("determineCursorContext: unknown after closing value", () => {
  const ctx = determineCursorContext('modelName == "scanner" ', 23);
  assertEquals(ctx, { kind: "unknown" });
});

// Map literal contexts (for SELECT projections)

Deno.test("determineCursorContext: root after colon in map literal", () => {
  const expr = '{"name": ';
  const ctx = determineCursorContext(expr, expr.length);
  assertEquals(ctx, { kind: "root", prefix: "" });
});

Deno.test("determineCursorContext: typing field after colon in map literal", () => {
  const expr = '{"name": spec';
  const ctx = determineCursorContext(expr, expr.length);
  assertEquals(ctx, { kind: "root", prefix: "spec" });
});

Deno.test("determineCursorContext: no autocomplete after comma in map literal", () => {
  const expr = '{"name": specName, ';
  const ctx = determineCursorContext(expr, expr.length);
  assertEquals(ctx, { kind: "unknown" });
});

Deno.test("determineCursorContext: no autocomplete after opening brace", () => {
  const ctx = determineCursorContext("{ ", 2);
  assertEquals(ctx, { kind: "unknown" });
});

Deno.test("determineCursorContext: member access after colon in map", () => {
  const expr = '{"os": attributes.';
  const ctx = determineCursorContext(expr, expr.length);
  assertEquals(ctx, {
    kind: "member",
    root: "attributes",
    chain: [],
    prefix: "",
  });
});

Deno.test("determineCursorContext: typing field after comma in map", () => {
  const expr = '{"name": specName, "data": attr';
  const ctx = determineCursorContext(expr, expr.length);
  assertEquals(ctx, { kind: "root", prefix: "attr" });
});

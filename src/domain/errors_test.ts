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

import { assertEquals, assertStrictEquals } from "@std/assert";
import { errorPaths, markErrorPaths, UserError } from "./errors.ts";

Deno.test("markErrorPaths: returns the same error with its paths marked", () => {
  const error = new UserError("Failed to read /opt/acme/final report.yaml");
  const marked = markErrorPaths(error, ["/opt/acme/final report.yaml"]);
  assertStrictEquals(marked, error);
  assertEquals(errorPaths(error), ["/opt/acme/final report.yaml"]);
});

Deno.test("markErrorPaths: appends and skips undefined and empty values", () => {
  const error = new Error("x");
  markErrorPaths(error, ["/a/b", undefined, ""]);
  markErrorPaths(error, ["/c/d"]);
  assertEquals(errorPaths(error), ["/a/b", "/c/d"]);
});

Deno.test("markErrorPaths: leaves an error unmarked when given no values", () => {
  const error = new Error("x");
  markErrorPaths(error, [undefined]);
  assertEquals(Object.getOwnPropertySymbols(error).length, 0);
  assertEquals(errorPaths(error), []);
});

Deno.test("markErrorPaths: keeps the paths out of JSON, keys and inspection", () => {
  const error = markErrorPaths(new UserError("boom", "code"), ["/secret/x"]);
  assertEquals(Object.keys(error).sort(), ["code", "name"]);
  assertEquals(JSON.stringify(error).includes("/secret/x"), false);
  assertEquals(
    Deno.inspect(error, { showHidden: false }).includes("/secret/x"),
    false,
  );
});

Deno.test("errorPaths: collects from the cause chain and de-duplicates", () => {
  const inner = markErrorPaths(new Error("inner"), ["/a/x", "/b/y"]);
  const outer = markErrorPaths(new Error("outer", { cause: inner }), ["/a/x"]);
  assertEquals(errorPaths(outer), ["/a/x", "/b/y"]);
});

Deno.test("errorPaths: collects from an AggregateError's errors", () => {
  const error = new AggregateError([
    markErrorPaths(new Error("one"), ["/one/x"]),
    markErrorPaths(new Error("two"), ["/two/y"]),
  ]);
  assertEquals(errorPaths(error), ["/one/x", "/two/y"]);
});

Deno.test("errorPaths: stops on a cause cycle", () => {
  const a = markErrorPaths(new Error("a"), ["/a/x"]);
  const b = markErrorPaths(new Error("b", { cause: a }), ["/b/y"]);
  (a as { cause?: unknown }).cause = b;
  assertEquals(errorPaths(b), ["/b/y", "/a/x"]);
});

Deno.test("errorPaths: returns nothing for non-Error values", () => {
  assertEquals(errorPaths("/a/b"), []);
  assertEquals(errorPaths(undefined), []);
  assertEquals(errorPaths({ message: "/a/b" }), []);
});

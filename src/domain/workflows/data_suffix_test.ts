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

import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { coerceToSuffix } from "./data_suffix.ts";

Deno.test("coerceToSuffix: returns string for primitive values", () => {
  assertEquals(coerceToSuffix("hello"), "hello");
  assertEquals(coerceToSuffix(42), "42");
  assertEquals(coerceToSuffix(true), "true");
});

Deno.test("coerceToSuffix: returns empty string for null and undefined", () => {
  assertEquals(coerceToSuffix(null), "");
  assertEquals(coerceToSuffix(undefined), "");
});

Deno.test("coerceToSuffix: uses key property from object", () => {
  assertEquals(coerceToSuffix({ key: "my-key", value: "stuff" }), "my-key");
});

Deno.test("coerceToSuffix: uses name property from object without key", () => {
  assertEquals(coerceToSuffix({ name: "my-name", id: "123" }), "my-name");
});

Deno.test("coerceToSuffix: uses id property from object without key or name", () => {
  assertEquals(coerceToSuffix({ id: "abc-123", other: "data" }), "abc-123");
});

Deno.test("coerceToSuffix: hashes an object without key, name or id", () => {
  assertMatch(coerceToSuffix({ foo: "bar", baz: 1 }), /^[0-9a-f]{16}$/);
});

Deno.test("coerceToSuffix: hash ignores object key order", () => {
  assertEquals(
    coerceToSuffix({ category: "Other", articles: [{ title: "t", n: 1 }] }),
    coerceToSuffix({ articles: [{ n: 1, title: "t" }], category: "Other" }),
  );
});

Deno.test("coerceToSuffix: objects sharing a long JSON prefix get distinct suffixes", () => {
  const title = "x".repeat(80);
  const policy = coerceToSuffix({ articles: [{ title }], category: "Policy" });
  const other = coerceToSuffix({ articles: [{ title }], category: "Other" });
  assertMatch(policy, /^[0-9a-f]{16}$/);
  assertMatch(other, /^[0-9a-f]{16}$/);
  assertNotEquals(policy, other);
});

Deno.test("coerceToSuffix: hashes an array", () => {
  assertMatch(coerceToSuffix(["a", { b: 1 }]), /^[0-9a-f]{16}$/);
  assertNotEquals(coerceToSuffix(["a"]), coerceToSuffix(["b"]));
});

Deno.test("coerceToSuffix: prefers key over name and id", () => {
  assertEquals(
    coerceToSuffix({ key: "k", name: "n", id: "i" }),
    "k",
  );
});

Deno.test("coerceToSuffix: skips null/undefined properties", () => {
  assertEquals(
    coerceToSuffix({ key: null, name: undefined, id: "fallback-id" }),
    "fallback-id",
  );
});

Deno.test("coerceToSuffix: sanitizes forward slashes in primitives", () => {
  assertEquals(coerceToSuffix("o11n/macos-runner"), "o11n--macos-runner");
});

Deno.test("coerceToSuffix: sanitizes backslashes in primitives", () => {
  assertEquals(coerceToSuffix("path\\to\\thing"), "path--to--thing");
});

Deno.test("coerceToSuffix: sanitizes double dots in primitives", () => {
  assertEquals(coerceToSuffix("../secret"), "----secret");
});

Deno.test("coerceToSuffix: sanitizes null bytes in primitives", () => {
  assertEquals(coerceToSuffix("bad\0value"), "badvalue");
});

Deno.test("coerceToSuffix: sanitizes multiple unsafe patterns together", () => {
  assertEquals(
    coerceToSuffix("a/b\\c..d\0e"),
    "a--b--c--de",
  );
});

Deno.test("coerceToSuffix: sanitizes unsafe characters in object key property", () => {
  assertEquals(
    coerceToSuffix({ key: "group/repo", value: "stuff" }),
    "group--repo",
  );
});

Deno.test("coerceToSuffix: sanitizes unsafe characters in object name property", () => {
  assertEquals(
    coerceToSuffix({ name: "path\\file", id: "123" }),
    "path--file",
  );
});

Deno.test("coerceToSuffix: sanitizes unsafe characters in object id property", () => {
  assertEquals(
    coerceToSuffix({ id: "../escape", other: "data" }),
    "----escape",
  );
});

Deno.test("coerceToSuffix: null bytes between dots do not reassemble into double dots", () => {
  assertEquals(coerceToSuffix(".\0."), "--");
  assertEquals(coerceToSuffix(".\0./secret"), "----secret");
});

Deno.test("coerceToSuffix: hash fallback holds no item content", () => {
  const suffix = coerceToSuffix({ path: "../a/b" });
  assertMatch(suffix, /^[0-9a-f]{16}$/);
  assertEquals(suffix.includes("path"), false);
});

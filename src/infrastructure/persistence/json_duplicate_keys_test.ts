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
import { findDuplicateJsonKey } from "./json_duplicate_keys.ts";

Deno.test("findDuplicateJsonKey: unique keys at every depth report nothing", () => {
  const content = JSON.stringify({
    a: { b: 1, c: [{ d: 2, e: 3 }, { d: 4 }] },
    f: "g",
    h: [],
    i: {},
  });
  assertEquals(findDuplicateJsonKey(content), undefined);
});

Deno.test("findDuplicateJsonKey: scalars and arrays without objects report nothing", () => {
  for (const content of ["null", "1", '"a"', "[1, [2, 3], []]", "{}"]) {
    assertEquals(findDuplicateJsonKey(content), undefined);
  }
});

Deno.test("findDuplicateJsonKey: reports a top-level repeat with an empty path", () => {
  const content = '{\n  "@example/one": {"version": "1.0.0"},\n' +
    '  "@example/one": {"version": "2.0.0"}\n}';
  assertEquals(findDuplicateJsonKey(content), {
    key: "@example/one",
    path: [],
  });
});

Deno.test("findDuplicateJsonKey: reports a repeat inside an entry with the entry's name", () => {
  const content =
    '{"@a/x": {"version": "1"}, "@b/y": {"version": "1", "version": "2"}}';
  assertEquals(findDuplicateJsonKey(content), {
    key: "version",
    path: ["@b/y"],
  });
});

Deno.test("findDuplicateJsonKey: a repeat inside an array element carries the index", () => {
  const content = '{"list": [{"a": 1}, 2, {"b": 1, "b": 2}]}';
  assertEquals(findDuplicateJsonKey(content), {
    key: "b",
    path: ["list", 2],
  });
});

Deno.test("findDuplicateJsonKey: the same key in sibling objects is not a repeat", () => {
  const content = '{"x": {"version": "1"}, "y": {"version": "2"}}';
  assertEquals(findDuplicateJsonKey(content), undefined);
});

Deno.test("findDuplicateJsonKey: an escaped and a literal spelling of one key are a repeat", () => {
  const content = '{"a": 1, "\\u0061": 2}';
  assertEquals(findDuplicateJsonKey(content), { key: "a", path: [] });
});

Deno.test("findDuplicateJsonKey: a key holding control characters is returned decoded", () => {
  const content = '{"\\u001b[31m": 1, "\\u001b[31m": 2}';
  assertEquals(findDuplicateJsonKey(content), {
    key: "\u001b[31m",
    path: [],
  });
});

Deno.test("findDuplicateJsonKey: punctuation inside strings does not confuse the scan", () => {
  const tricky = 'a"b\\c{d}[e],f:g';
  const content = JSON.stringify({ [tricky]: tricky, other: { [tricky]: 1 } });
  assertEquals(findDuplicateJsonKey(content), undefined);
  const repeated = `{${JSON.stringify(tricky)}: 1, ${
    JSON.stringify(tricky)
  }: 2}`;
  assertEquals(findDuplicateJsonKey(repeated), { key: tricky, path: [] });
});

Deno.test("findDuplicateJsonKey: a string value equal to an earlier key is not a repeat", () => {
  const content = '{"a": "a", "b": ["a", "b"]}';
  assertEquals(findDuplicateJsonKey(content), undefined);
});

Deno.test("findDuplicateJsonKey: scans input nested deeper than the call stack", () => {
  const depth = 20_000;
  const content = '{"k":'.repeat(depth) + '{"z": 1, "z": 2}' +
    "}".repeat(depth);
  const result = findDuplicateJsonKey(content);
  assertEquals(result?.key, "z");
  assertEquals(result?.path.length, depth);
  assertEquals(result?.path.every((segment) => segment === "k"), true);
});

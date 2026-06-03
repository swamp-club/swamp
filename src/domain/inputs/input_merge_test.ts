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
import { deepMerge } from "./input_merge.ts";

Deno.test("deepMerge: overrides take precedence over base for scalar keys", () => {
  const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
  assertEquals(result, { a: 1, b: 3, c: 4 });
});

Deno.test("deepMerge: new keys in overrides are additive", () => {
  const result = deepMerge({ region: "us-east" }, { authKey: "tskey-abc123" });
  assertEquals(result, { region: "us-east", authKey: "tskey-abc123" });
});

Deno.test("deepMerge: nested plain objects merge recursively", () => {
  const result = deepMerge(
    { server: { host: "localhost", port: 8080 } },
    { server: { port: 9090 } },
  );
  assertEquals(result, { server: { host: "localhost", port: 9090 } });
});

Deno.test("deepMerge: arrays are replaced, not merged", () => {
  const result = deepMerge({ tags: ["a", "b"] }, { tags: ["c"] });
  assertEquals(result, { tags: ["c"] });
});

Deno.test("deepMerge: a plain object override replaces a non-object base", () => {
  const result = deepMerge({ value: 5 }, { value: { nested: true } });
  assertEquals(result, { value: { nested: true } });
});

Deno.test("deepMerge: a scalar override replaces an object base", () => {
  const result = deepMerge({ value: { nested: true } }, { value: 5 });
  assertEquals(result, { value: 5 });
});

Deno.test("deepMerge: does not mutate the base object", () => {
  const base = { a: { b: 1 } };
  deepMerge(base, { a: { c: 2 } });
  assertEquals(base, { a: { b: 1 } });
});

Deno.test("deepMerge: empty overrides returns a copy of base", () => {
  const result = deepMerge({ a: 1 }, {});
  assertEquals(result, { a: 1 });
});

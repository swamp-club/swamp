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
import { inputsMatch } from "./input_matching.ts";

Deno.test("inputsMatch: empty records match", () => {
  assertEquals(inputsMatch({}, {}), true);
});

Deno.test("inputsMatch: identical primitive values match", () => {
  assertEquals(
    inputsMatch({ env: "prod", count: 42 }, { env: "prod", count: 42 }),
    true,
  );
});

Deno.test("inputsMatch: different values do not match", () => {
  assertEquals(
    inputsMatch({ env: "prod" }, { env: "staging" }),
    false,
  );
});

Deno.test("inputsMatch: different keys do not match", () => {
  assertEquals(
    inputsMatch({ env: "prod" }, { region: "prod" }),
    false,
  );
});

Deno.test("inputsMatch: extra key causes mismatch", () => {
  assertEquals(
    inputsMatch({ env: "prod" }, { env: "prod", region: "us-east-1" }),
    false,
  );
});

Deno.test("inputsMatch: key ordering does not matter", () => {
  assertEquals(
    inputsMatch(
      { region: "us-east-1", env: "prod" },
      { env: "prod", region: "us-east-1" },
    ),
    true,
  );
});

Deno.test("inputsMatch: nested objects match", () => {
  assertEquals(
    inputsMatch(
      { config: { timeout: 30, retries: 3 } },
      { config: { retries: 3, timeout: 30 } },
    ),
    true,
  );
});

Deno.test("inputsMatch: nested objects with different values do not match", () => {
  assertEquals(
    inputsMatch(
      { config: { timeout: 30 } },
      { config: { timeout: 60 } },
    ),
    false,
  );
});

Deno.test("inputsMatch: arrays match when identical", () => {
  assertEquals(
    inputsMatch({ tags: ["a", "b"] }, { tags: ["a", "b"] }),
    true,
  );
});

Deno.test("inputsMatch: arrays with different order do not match", () => {
  assertEquals(
    inputsMatch({ tags: ["a", "b"] }, { tags: ["b", "a"] }),
    false,
  );
});

Deno.test("inputsMatch: arrays with different lengths do not match", () => {
  assertEquals(
    inputsMatch({ tags: ["a"] }, { tags: ["a", "b"] }),
    false,
  );
});

Deno.test("inputsMatch: null values match", () => {
  assertEquals(
    inputsMatch({ value: null }, { value: null }),
    true,
  );
});

Deno.test("inputsMatch: null vs undefined do not match", () => {
  assertEquals(
    inputsMatch({ value: null }, { value: undefined }),
    false,
  );
});

Deno.test("inputsMatch: boolean values match", () => {
  assertEquals(
    inputsMatch({ enabled: true }, { enabled: true }),
    true,
  );
});

Deno.test("inputsMatch: boolean vs string do not match", () => {
  assertEquals(
    inputsMatch({ enabled: true }, { enabled: "true" }),
    false,
  );
});

Deno.test("inputsMatch: mixed complex structure matches", () => {
  assertEquals(
    inputsMatch(
      { env: "prod", tags: ["deploy"], config: { timeout: 30 } },
      { config: { timeout: 30 }, env: "prod", tags: ["deploy"] },
    ),
    true,
  );
});

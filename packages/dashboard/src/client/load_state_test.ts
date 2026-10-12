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
import { loadState } from "./load_state.ts";
import { extractArray } from "./extract.ts";

const wrappedEmpty = (d: unknown) => extractArray(d).length === 0;

Deno.test("loadState: no data while in flight is loading", () => {
  assertEquals(
    loadState({ data: null, loading: true, error: null }),
    "loading",
  );
});

Deno.test("loadState: no data and not yet sent is loading, never empty", () => {
  assertEquals(
    loadState({ data: null, loading: false, error: null }),
    "loading",
  );
});

Deno.test("loadState: a failure with no data is error", () => {
  assertEquals(
    loadState({ data: null, loading: false, error: "boom" }),
    "error",
  );
});

Deno.test("loadState: a resolved empty array is empty", () => {
  assertEquals(loadState({ data: [], loading: false, error: null }), "empty");
});

Deno.test("loadState: a resolved non-empty array is ready", () => {
  assertEquals(loadState({ data: [1], loading: false, error: null }), "ready");
});

Deno.test("loadState: non-array data is ready by default", () => {
  assertEquals(
    loadState({ data: { data: [] }, loading: false, error: null }),
    "ready",
  );
});

Deno.test("loadState: a custom isEmpty sees through the payload wrapper", () => {
  const empty = { data: { results: [] } };
  const full = { data: { results: [{ name: "a" }] } };
  assertEquals(
    loadState({ data: empty, loading: false, error: null }, wrappedEmpty),
    "empty",
  );
  assertEquals(
    loadState({ data: full, loading: false, error: null }, wrappedEmpty),
    "ready",
  );
});

Deno.test("loadState: earlier data wins over a refetch in flight or failing", () => {
  assertEquals(loadState({ data: [1], loading: true, error: null }), "ready");
  assertEquals(
    loadState({ data: [1], loading: false, error: "boom" }),
    "ready",
  );
});

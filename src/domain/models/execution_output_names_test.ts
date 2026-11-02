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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import { ExecutionOutputNames } from "./execution_output_names.ts";

Deno.test("ExecutionOutputNames.claim: a repeat under the same kind and spec is allowed", () => {
  const names = new ExecutionOutputNames();
  names.claim("x", "resource", "meta");
  names.claim("x", "resource", "meta");
});

Deno.test("ExecutionOutputNames.claim: a different kind under a held name is refused", () => {
  const names = new ExecutionOutputNames();
  names.claim("x", "file", "blob");
  const error = assertThrows(
    () => names.claim("x", "resource", "meta"),
    UserError,
  );
  assertEquals(
    error.message,
    "Duplicate data instance name 'x' (already written as file 'blob' in this run)",
  );
});

Deno.test("ExecutionOutputNames.claim: a different spec of the same kind is refused", () => {
  const names = new ExecutionOutputNames();
  names.claim("x", "resource", "summary");
  assertThrows(
    () => names.claim("x", "resource", "repo"),
    UserError,
    "already written as resource 'summary'",
  );
});

Deno.test("ExecutionOutputNames.claim: a refused claim leaves the first holder in place", () => {
  const names = new ExecutionOutputNames();
  names.claim("x", "resource", "meta");
  assertThrows(() => names.claim("x", "file", "blob"), UserError);
  names.claim("x", "resource", "meta");
  assertThrows(
    () => names.claim("x", "file", "blob"),
    UserError,
    "already written as resource 'meta'",
  );
});

Deno.test("ExecutionOutputNames.claim: distinct names do not clash", () => {
  const names = new ExecutionOutputNames();
  names.claim("x-file", "file", "blob");
  names.claim("x", "resource", "meta");
});

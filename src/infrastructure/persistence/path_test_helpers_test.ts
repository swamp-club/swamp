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

import { AssertionError, assertThrows } from "@std/assert";
import { assertPathEquals } from "./path_test_helpers.ts";

Deno.test("assertPathEquals: forward-slash paths compare equal", () => {
  assertPathEquals("/repo/foo/bar", "/repo/foo/bar");
});

Deno.test("assertPathEquals: backslash actual matches forward-slash expected", () => {
  assertPathEquals("\\repo\\foo\\bar", "/repo/foo/bar");
});

Deno.test("assertPathEquals: forward-slash actual matches backslash expected", () => {
  assertPathEquals("/repo/foo/bar", "\\repo\\foo\\bar");
});

Deno.test("assertPathEquals: mixed separators normalize to equal", () => {
  assertPathEquals("/repo\\foo/bar", "\\repo/foo\\bar");
});

Deno.test("assertPathEquals: genuinely different paths still throw", () => {
  assertThrows(
    () => assertPathEquals("/repo/foo", "/repo/bar"),
    AssertionError,
  );
});

Deno.test("assertPathEquals: optional message is forwarded", () => {
  const err = assertThrows(
    () => assertPathEquals("a", "b", "custom-msg"),
    AssertionError,
  );
  if (!err.message.includes("custom-msg")) {
    throw new Error(
      `expected message to include 'custom-msg', got: ${err.message}`,
    );
  }
});

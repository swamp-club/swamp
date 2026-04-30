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

/**
 * Test assertion that compares two filesystem paths irrespective of
 * platform separator. Both `actual` and `expected` are normalized to
 * forward slashes before comparison so tests can use forward-slash
 * literals in their expected values regardless of host OS.
 *
 * On POSIX, the `replaceAll("\\", "/")` normalization is a no-op since
 * POSIX paths do not contain backslashes — behaviour is identical to
 * `assertEquals` for any path string. On Windows, where `Deno.realPath`,
 * `@std/path/join`, etc. produce backslash-separated paths, the
 * normalization on both sides makes string-equality assertions work
 * cross-platform without per-test platform branching.
 *
 * Use this for any test that asserts string equality on a filesystem
 * path. Do not use it for assertions on URL pathnames, S3 keys, or
 * anything else where backslashes are semantically distinct.
 */
export function assertPathEquals(
  actual: string | undefined,
  expected: string | undefined,
  msg?: string,
): void {
  if (typeof actual === "string" && typeof expected === "string") {
    assertEquals(
      actual.replaceAll("\\", "/"),
      expected.replaceAll("\\", "/"),
      msg,
    );
  } else {
    // One or both is undefined — fall back to plain equality so the
    // failure surfaces with a useful diff (undefined vs "<expected>").
    assertEquals(actual, expected, msg);
  }
}

/**
 * Array variant of `assertPathEquals` — normalizes every element of both
 * arrays to forward slashes before comparison. Use when asserting on lists
 * of paths produced by `@std/path/join` or similar.
 */
export function assertPathArrayEquals(
  actual: string[],
  expected: string[],
  msg?: string,
): void {
  assertEquals(
    actual.map((s) => s.replaceAll("\\", "/")),
    expected.map((s) => s.replaceAll("\\", "/")),
    msg,
  );
}

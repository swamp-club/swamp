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

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";

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

/**
 * Substring variant of `assertPathEquals` — asserts that a path contains
 * the given (forward-slash) substring, regardless of host separator.
 * Equivalent to `assertStringIncludes(actual, expected)` after both sides
 * are normalized to forward slashes.
 */
export function assertPathStringIncludes(
  actual: string,
  expected: string,
  msg?: string,
): void {
  assertStringIncludes(
    actual.replaceAll("\\", "/"),
    expected.replaceAll("\\", "/"),
    msg,
  );
}

/**
 * Regex variant of `assertPathEquals` — asserts that a path matches the
 * given regex (authored with forward slashes), regardless of host
 * separator.
 */
export function assertPathMatches(
  actual: string,
  expected: RegExp,
  msg?: string,
): void {
  assertMatch(actual.replaceAll("\\", "/"), expected, msg);
}

const MOCKED_ENV_READERS = ["get", "has", "toObject"] as const;

/**
 * Runs `fn` with `Deno.env.get`, `Deno.env.has` and `Deno.env.toObject`
 * answering from `overrides` instead of the process environment. A key mapped
 * to `undefined` reads as unset (and is absent from `toObject`); keys not in
 * `overrides` pass through to the real environment. When `fn` returns a
 * promise, the original readers are restored once it settles.
 *
 * Use this instead of `Deno.env.set` / `Deno.env.delete` in tests.
 * `deno test --parallel` runs every test file in one process, so a real
 * mutation is visible to every other file running at the same moment;
 * replacing the readers only affects the current file's worker. Map every
 * variable the test needs unset to `undefined` explicitly — an absent key
 * reads the developer's real environment. Writes made inside `fn` still go to
 * the real environment, and child processes never see the overrides: pass
 * them an explicit `env` instead. Override keys match exactly, even on Windows
 * where the real environment is case-insensitive (`PATH` is not `Path`).
 */
export function withMockedEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T,
): T {
  const originals = MOCKED_ENV_READERS.map((name) =>
    [name, Object.getOwnPropertyDescriptor(Deno.env, name)] as const
  );
  const realGet = Deno.env.get.bind(Deno.env);
  const realHas = Deno.env.has.bind(Deno.env);
  const realToObject = Deno.env.toObject.bind(Deno.env);
  const mocked: Record<(typeof MOCKED_ENV_READERS)[number], unknown> = {
    get: (key: string) =>
      Object.hasOwn(overrides, key) ? overrides[key] : realGet(key),
    has: (key: string) =>
      Object.hasOwn(overrides, key)
        ? overrides[key] !== undefined
        : realHas(key),
    toObject: () => {
      const env = realToObject();
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      return env;
    },
  };
  for (const name of MOCKED_ENV_READERS) {
    Object.defineProperty(Deno.env, name, {
      configurable: true,
      writable: true,
      value: mocked[name],
    });
  }
  const restore = () => {
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(Deno.env, name, original);
      else delete (Deno.env as Partial<Pick<Deno.Env, typeof name>>)[name];
    }
  };

  let result: T;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}

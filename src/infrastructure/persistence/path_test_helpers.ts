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
import { OUTPUT_SUMMARIES_DIR } from "./output_summary_index.ts";
import { swampPath } from "./paths.ts";

/**
 * normalizes both sides to forward slashes; do not use it for URL pathnames, S3
 * keys or anything else where backslashes are semantically distinct
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
    assertEquals(actual, expected, msg);
  }
}

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

export function assertPathMatches(
  actual: string,
  expected: RegExp,
  msg?: string,
): void {
  assertMatch(actual.replaceAll("\\", "/"), expected, msg);
}

const MOCKED_ENV_READERS = ["get", "has", "toObject"] as const;

/**
 * replaces the env readers for the current test file only, since test files
 * share a process; map every variable that must be unset to undefined, and
 * child processes never see overrides
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

export async function disableOutputSummaries(repoDir: string): Promise<void> {
  const path = swampPath(repoDir, OUTPUT_SUMMARIES_DIR);
  await Deno.mkdir(swampPath(repoDir), { recursive: true });
  await Deno.writeTextFile(path, "");
}

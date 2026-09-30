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

/**
 * Base error for user-facing errors that should not show a stack trace.
 * Use this for validation errors, "model not found" messages, and other
 * expected error conditions where the stack trace would be noise.
 *
 * The optional `code` carries a machine-readable identifier (e.g.
 * `"cancelled"`, `"timeout"`) that surfaces in JSON error output.
 */
export class UserError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "UserError";
    this.code = code;
  }
}

/**
 * Where an error keeps the filesystem paths it names. A module-private symbol
 * on a non-enumerable property, so JSON output, `Object.keys` and default
 * inspection never see it.
 */
const ERROR_PATHS = Symbol("swamp.errorPaths");

/** How far {@link errorPaths} follows `cause` and `AggregateError` links. */
const MAX_ERROR_DEPTH = 8;

/**
 * Marks the filesystem paths an error's message names, so telemetry can remove
 * them exactly instead of guessing where each one ends (swamp-club#2830). Mark
 * the value as it appears in the message. Undefined and empty values are
 * skipped, and marking again appends.
 *
 * @param error - The error whose message names the paths
 * @param paths - The paths, exactly as interpolated into the message
 * @returns The same error, so a call site can `throw markErrorPaths(...)`
 */
export function markErrorPaths<E extends Error>(
  error: E,
  paths: readonly (string | undefined)[],
): E {
  const added = paths.filter((p): p is string =>
    typeof p === "string" && p.length > 0
  );
  if (added.length === 0) return error;
  const holder = error as unknown as Record<symbol, string[] | undefined>;
  const existing = holder[ERROR_PATHS];
  if (existing) {
    existing.push(...added);
  } else {
    Object.defineProperty(error, ERROR_PATHS, {
      value: added,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  return error;
}

/**
 * The paths marked on an error with {@link markErrorPaths}, including those on
 * its `cause` chain and on an `AggregateError`'s errors. De-duplicated, safe
 * against cycles, and empty for anything that is not an Error.
 *
 * @param value - A caught value
 */
export function errorPaths(value: unknown): string[] {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (current: unknown, depth: number): void => {
    if (!(current instanceof Error) || seen.has(current)) return;
    if (depth > MAX_ERROR_DEPTH) return;
    seen.add(current);
    const marked = (current as unknown as Record<symbol, string[] | undefined>)[
      ERROR_PATHS
    ];
    for (const path of marked ?? []) found.add(path);
    visit(current.cause, depth + 1);
    if (current instanceof AggregateError) {
      for (const inner of current.errors) visit(inner, depth + 1);
    }
  };
  visit(value, 0);
  return [...found];
}

/**
 * Exhaustiveness check for switch statements.
 * TypeScript will error at compile time if a case is missing.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

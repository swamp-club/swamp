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
 * The unscoped-write guard for test harnesses (swamp-club#3056).
 *
 * `signalChange` reports each hooked write that took route 2, the hook
 * fallback for a write made outside every unit bound to its hook. Inside
 * {@link withUnscopedWriteGuard}, a report whose caller is production code
 * (`src/`) fails the test, unless the caller is pinned in
 * {@link PINNED_UNSCOPED_WRITERS}. Writes made from test code itself
 * (fixtures and integration helpers) are ignored.
 *
 * The guard throws at the write, and also checks again when `fn` ends, so a
 * write whose error production code catches and only logs still fails the
 * test.
 *
 * @module
 */

import {
  type UnscopedCaller,
  type UnscopedChange,
  useUnscopedChangeReporterForTesting,
} from "../src/infrastructure/persistence/unit_of_work_scope.ts";

/** A production caller allowed to write on route 2, with the reason why. */
export interface PinnedUnscopedWriter {
  /** `src/<path>.ts: <function>`, as {@link unscopedWriterKey} renders it. */
  readonly writer: string;
  readonly reason: string;
}

/**
 * Production callers that still write on route 2 because they cannot take a
 * root unit of work without a behaviour change. They still log the
 * production warning. Empty: every route-2 caller found runs in a root. It
 * lives here, not in `datastore_write_seams_rules_test.ts`, because the
 * guard reads it at runtime and a test file must not be imported; that rule
 * file checks it.
 */
export const PINNED_UNSCOPED_WRITERS: readonly PinnedUnscopedWriter[] = [];

/**
 * The pin key for a caller (`src/serve/bookkeeping_gc.ts: reapBatch`), or
 * undefined when the caller is not production code (outside `src/`, or a
 * test file under it).
 */
export function unscopedWriterKey(
  caller: UnscopedCaller | undefined,
): string | undefined {
  if (
    caller === undefined || !caller.file.startsWith("src/") ||
    /_test\.tsx?$/.test(caller.file)
  ) {
    return undefined;
  }
  return `${caller.file}: ${caller.fn ?? "<anonymous>"}`;
}

function describe({ change, caller }: UnscopedChange): string {
  const target = change.kind === "bulk" ? change.reason : change.path;
  const site = caller === undefined
    ? "an unknown caller"
    : `${caller.file}:${caller.line}${
      caller.fn === undefined ? "" : ` (${caller.fn})`
    }`;
  return `${change.kind} ${target} from ${site}`;
}

let active = false;

/**
 * Runs `fn` with route-2 writes from production code failing the test.
 * Guards nest: an inner call inside an active guard just runs `fn`.
 */
export async function withUnscopedWriteGuard<T>(
  fn: () => Promise<T>,
): Promise<T> {
  if (active) return await fn();
  const pinned = new Set(PINNED_UNSCOPED_WRITERS.map((pin) => pin.writer));
  const unscoped: string[] = [];
  const dispose = useUnscopedChangeReporterForTesting((report) => {
    const key = unscopedWriterKey(report.caller);
    if (key === undefined || pinned.has(key)) return;
    const description = describe(report);
    unscoped.push(description);
    throw new Error(
      `A hooked write ran outside a unit of work (route 2): ${description}. ` +
        "Run its command, request or job in a root unit of work " +
        "(runInRootUnitOfWork) or pin it in PINNED_UNSCOPED_WRITERS.",
    );
  });
  active = true;
  let value: T;
  try {
    value = await fn();
  } catch (error) {
    if (unscoped.length === 0) throw error;
    throw new Error(unscopedMessage(unscoped), { cause: error });
  } finally {
    active = false;
    dispose();
  }
  if (unscoped.length > 0) throw new Error(unscopedMessage(unscoped));
  return value;
}

function unscopedMessage(unscoped: readonly string[]): string {
  return "Hooked writes ran outside a unit of work (route 2):\n" +
    unscoped.map((line) => `  - ${line}`).join("\n");
}

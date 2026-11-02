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
 * fails the test when production code makes a hooked write outside every unit
 * (route 2) unless the caller is pinned; it checks again when fn ends, so a
 * caught and logged error still fails
 */

import {
  formatUnscopedCaller,
  type UnscopedCaller,
  type UnscopedChange,
  useUnscopedChangeReporterForTesting,
} from "../src/infrastructure/persistence/unit_of_work_scope.ts";

export interface PinnedUnscopedWriter {
  readonly writer: string;
  readonly reason: string;
}

/**
 * production callers that write on route 2 because they cannot take a root unit
 * without a behaviour change; empty now. It lives here because the guard reads
 * it at runtime and a test file must not be imported
 */
export const PINNED_UNSCOPED_WRITERS: readonly PinnedUnscopedWriter[] = [];

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
  return `${change.kind} ${target} from ${formatUnscopedCaller(caller)}`;
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

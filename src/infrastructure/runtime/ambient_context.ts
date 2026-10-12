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
 * The async context swamp starts with, before any run enters a scope.
 *
 * Deno can call a `Deno.serve` handler with the async context the last code
 * that ran left behind: after a first-time dynamic `import()` inside an
 * `AsyncLocalStorage` scope, every later request inherits that scope
 * (swamp-club#3125). swamp keeps ambient authority in such stores — a run's
 * vault scope, unit of work, held lock ids, trace frames and extension lock
 * leases — so a request must not see them.
 *
 * The snapshot is taken when this module is evaluated, which must happen at
 * startup, while no scope is entered: import this module statically only.
 * Evaluated inside a run, it would capture that run's context instead.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const rootContext = AsyncLocalStorage.snapshot();

/**
 * Runs `fn` outside every `AsyncLocalStorage` store, current and future:
 * each store reads `undefined` inside `fn` and in the work it continues
 * into, while stores `fn` enters itself work as usual.
 */
export function runOutsideAmbientContext<T>(fn: () => T): T {
  return rootContext(fn);
}

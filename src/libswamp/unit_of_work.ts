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
 * Runs a write use case inside one unit of work: datastore rework Phase 2
 * (swamp-club#3025).
 *
 * The use case is the application service, so it owns the transaction
 * boundary. Each exported write use case keeps its signature and wraps its
 * body: `yield* withUnitOfWork(ctx, () => ...)`.
 * `PINNED_TRANSACTIONAL_USE_CASES` in
 * `integration/datastore_write_seams_rules_test.ts` lists them, and this
 * module is the only production code that opens an ambient scope.
 *
 * @module
 */

import { runInUnitOfWork } from "../infrastructure/persistence/unit_of_work_scope.ts";
import type { LibSwampContext } from "./context.ts";

/**
 * Drives `inner` inside a unit of work opened from `ctx.openUnitOfWork()`.
 *
 * - **Scope.** `inner` is created, and every `next()` and a forwarded
 *   `return()` run, inside `runInUnitOfWork`, so all code the generator runs
 *   between yields sees the unit. `AsyncLocalStorage` does not flow into a
 *   generator any other way. Code the consumer runs between events is
 *   outside the scope.
 * - **Events** are re-yielded unchanged, in order.
 * - **Commit.** Once, after `inner` yields `completed` (and no `error`) and
 *   then finishes. Writes a use case makes after yielding `completed` are
 *   inside the unit when the consumer drains the stream.
 * - **Abandon.** No commit when `inner` yields `error`, throws, ends on any
 *   other terminal, or the consumer stops early (`return()`, as `result()`
 *   does at `completed`). The abandoned unit's changes were already sent to
 *   the hook, exactly as before units of work. Open decision for the step
 *   that moves the push into `commit`: `workflowRun` also ends on
 *   `suspended` and `cancelled`, which abandon the unit today, so a
 *   suspended run's state would not be pushed by `commit`.
 * - **Nesting.** A use case run inside another opens its own unit; the
 *   innermost unit is ambient while it runs.
 */
export async function* withUnitOfWork<E extends { kind: string }>(
  ctx: LibSwampContext,
  inner: () => AsyncIterable<E>,
): AsyncGenerator<E> {
  const uow = ctx.openUnitOfWork();
  const iterator = await runInUnitOfWork(
    uow,
    () => Promise.resolve(inner()[Symbol.asyncIterator]()),
  );
  let done = false;
  let completed = false;
  let failed = false;
  try {
    while (true) {
      let result: IteratorResult<E>;
      try {
        result = await runInUnitOfWork(uow, () => iterator.next());
      } catch (error) {
        // The inner iterator threw, so it has already finished.
        done = true;
        throw error;
      }
      if (result.done) {
        done = true;
        break;
      }
      if (result.value.kind === "completed") completed = true;
      if (result.value.kind === "error") failed = true;
      yield result.value;
    }
  } finally {
    if (!done) {
      await runInUnitOfWork(uow, async () => {
        await iterator.return?.();
      });
    }
  }
  if (completed && !failed) await uow.commit();
}

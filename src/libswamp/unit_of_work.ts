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

import type { UnitOfWork } from "../domain/datastore/unit_of_work.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { runInUnitOfWork } from "../infrastructure/persistence/unit_of_work_scope.ts";
import type { LibSwampContext } from "./context.ts";

const logger = getSwampLogger(["datastore", "unit-of-work"]);

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
 * - **Abandon.** Once, on every other ending: `inner` yields `error`,
 *   throws, ends on another terminal (`workflowRun` ends on `suspended` or
 *   `cancelled`), or the consumer stops early with `return()`. `result()`
 *   stops at `completed` that way, so most use cases end their unit through
 *   abandon even when they succeeded. If abandon fails while an error is
 *   already propagating, it is logged at warn and the original error wins.
 * - **Terminal policy.** For legacy units which ending is chosen does not
 *   change what is pushed: a use case's unit is a child of the command's or
 *   request's root (or has no flush), and the root decides the push. A
 *   Phase 3 unit that discards on abandon must decide what to commit on
 *   `suspended` and `cancelled` (the open item from swamp-club#3025's
 *   review), and must treat `completed` followed by `return()` as success.
 * - **Nesting.** A use case run inside another opens its own unit, which is
 *   a child of the outer one when both are bound to the same hook; the
 *   innermost unit is ambient while it runs.
 */
export async function* withUnitOfWork<E extends { kind: string }>(
  ctx: LibSwampContext,
  inner: () => AsyncIterable<E>,
): AsyncGenerator<E> {
  const uow = ctx.openUnitOfWork();
  let iterator: AsyncIterator<E>;
  try {
    iterator = await runInUnitOfWork(
      uow,
      () => Promise.resolve(inner()[Symbol.asyncIterator]()),
    );
  } catch (error) {
    await abandonQuietly(uow);
    throw error;
  }
  let done = false;
  let completed = false;
  let failed = false;
  let succeeded = false;
  let thrown = false;
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
    succeeded = completed && !failed;
  } catch (error) {
    thrown = true;
    throw error;
  } finally {
    // Runs on every ending, including the consumer's return(), after which
    // no code past this block runs. A return() that throws propagates on its
    // own, so abandon must not mask it.
    let returned = false;
    try {
      if (!done) {
        await runInUnitOfWork(uow, async () => {
          await iterator.return?.();
        });
      }
      returned = true;
    } finally {
      if (succeeded) await uow.commit();
      else if (thrown || !returned) await abandonQuietly(uow);
      else await uow.abandon();
    }
  }
}

/** Abandons `uow` while another error propagates, never masking it. */
async function abandonQuietly(uow: UnitOfWork): Promise<void> {
  try {
    await uow.abandon();
  } catch (abandonError) {
    logger.warn`Abandoning a unit of work failed: ${abandonError}`;
  }
}

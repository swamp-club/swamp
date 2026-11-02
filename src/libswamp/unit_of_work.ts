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

import {
  rethrowUnrecordedEnd,
  type UnitOfWork,
} from "../domain/datastore/unit_of_work.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  currentUnitOfWork,
  runInUnitOfWork,
  takesTypedChanges,
} from "../infrastructure/persistence/unit_of_work_scope.ts";
import type { LibSwampContext } from "./context.ts";

const logger = getSwampLogger(["datastore", "unit-of-work"]);

/**
 * inner runs inside the unit so code between yields sees it, as
 * AsyncLocalStorage does not flow into a generator; commits on completion,
 * abandons otherwise, and an abandon failure never masks an error
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
    await abandonQuietly(uow, error);
    throw error;
  }
  let done = false;
  let completed = false;
  // A run's terminal outcome: `completed`, `suspended` or `cancelled`.
  let terminal = false;
  let failed = false;
  let succeeded = false;
  let thrown = false;
  let thrownError: unknown;
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
      if (TERMINAL_KINDS.has(result.value.kind)) terminal = true;
      if (result.value.kind === "error") failed = true;
      yield result.value;
    }
    succeeded = completed && !failed;
  } catch (error) {
    thrown = true;
    thrownError = error;
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
      // A v3 unit commits once the stream reached an outcome, even if the
      // consumer stopped with return(), and abandons on a throw or earlier
      // stop.
      const commits = takesTypedChanges(uow)
        ? (terminal || failed || outcomeReported.has(uow)) && !thrown &&
          returned
        : succeeded;
      if (commits) await uow.commit();
      else if (thrown || !returned) await abandonQuietly(uow, thrownError);
      else await uow.abandon();
    }
  }
}

const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  "completed",
  "suspended",
  "cancelled",
]);

const outcomeReported = new WeakSet<UnitOfWork>();

/**
 * records an outcome the stream has not reported yet, so a v3 unit commits at
 * stream end as after a terminal event; legacy units and calls outside a unit
 * ignore it
 */
export function markOutcomeReported(): void {
  const uow = currentUnitOfWork();
  if (uow !== undefined) outcomeReported.add(uow);
}

/**
 * abandons while another error propagates; only an abandon that could not
 * record its outcome masks that error
 */
async function abandonQuietly(
  uow: UnitOfWork,
  failure: unknown,
): Promise<void> {
  try {
    await uow.abandon();
  } catch (abandonError) {
    rethrowUnrecordedEnd(abandonError, failure);
    logger
      .warn`Finishing datastore changes after a failed operation also failed: ${abandonError}`;
  }
}

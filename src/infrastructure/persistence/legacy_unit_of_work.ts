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

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";
import { getSwampLogger } from "../logging/logger.ts";

/**
 * What a legacy unit of work does with a change staged after it committed.
 *
 * - `"reject"`: `stage` rejects with "unit of work already committed". Tests
 *   use it, so a write that escapes its use case fails the test.
 * - `"forward"`: `stage` sends the change straight to the hook, as a write
 *   outside any unit of work would, and logs it at debug. Production uses it,
 *   so a write that escapes its use case never fails a command.
 */
export type AfterCommitPolicy = "reject" | "forward";

/** Options for {@link createLegacyUnitOfWork}. */
export interface LegacyUnitOfWorkOptions {
  /**
   * Pushes the marked changes; `commit` awaits it. Required so every caller
   * decides: pass `undefined` only where there is nothing to push
   * (filesystem datastores), because `commit` then pushes nothing.
   */
  flush: (() => Promise<void>) | undefined;
  /** Late-stage handling; defaults to `"reject"`. See {@link AfterCommitPolicy}. */
  afterCommit?: AfterCommitPolicy;
}

const logger = getSwampLogger(["datastore", "unit-of-work"]);

/**
 * The hook each legacy unit of work forwards to, by unit. Kept beside the
 * adapter, not on the {@link UnitOfWork} port: which hook a unit belongs to
 * is an adapter detail, and a unit built any other way can never claim one.
 */
const targets = new WeakMap<UnitOfWork, MarkDirtyHook>();

/**
 * The mark hook `uow` forwards to, when `uow` came from
 * {@link createLegacyUnitOfWork} with a hook. Undefined for a unit created
 * without a hook and for any other {@link UnitOfWork}.
 *
 * A repository stages into an ambient unit of work only when this is its own
 * hook (`signalChange` in `unit_of_work_scope.ts`), so a unit opened for one
 * repository context never takes another context's changes.
 *
 * The binding recognises legacy units only. A Phase 3 adapter needs its own
 * way to claim a repository context.
 */
export function legacyUnitOfWorkTarget(
  uow: UnitOfWork,
): MarkDirtyHook | undefined {
  return targets.get(uow);
}

/**
 * A {@link UnitOfWork} over today's {@link MarkDirtyHook}: datastore rework
 * Phase 1.
 *
 * `stage` forwards each change straight away: `write` and `remove` become
 * `markDirty(path)`, and `bulk` becomes `markDirty(undefined)`. It never
 * batches, deduplicates, reorders or defers, because the `markDirty`
 * contract depends on pre-write timing and on the order of bulk and per-path
 * marks (rules 1 and 8 on `DatastoreSyncService.markDirty`). The S3 and GCS
 * extensions drop path marks that arrive after a bulk mark. A rejected hook
 * rejects `stage` with the same error, as `notifyDirty` does today. With no
 * hook (filesystem datastores) `stage` only records the change.
 *
 * `commit` waits for any mark still in flight, then awaits `options.flush`
 * when one is given. Use cases commit their unit through `withUnitOfWork`
 * (`src/libswamp/unit_of_work.ts`), but every production unit has no flush
 * yet: the existing flush paths (`acquireModelLocks().flush`,
 * `flushDatastoreSync`, `pushManagedConfigChanges`, serve's
 * `pushChangedToRemote`) keep pushing as they do today. A later Phase 2 step
 * moves the push into `commit`.
 *
 * A change staged after `commit` follows `options.afterCommit`. With
 * `"forward"` it is not recorded in `staged()`: the unit is spent, and the
 * change reaches the hook exactly as it would outside any unit of work.
 */
export function createLegacyUnitOfWork(
  markDirty: MarkDirtyHook | undefined,
  options: LegacyUnitOfWorkOptions,
): UnitOfWork {
  const changes: StagedChange[] = [];
  const marks: Promise<void>[] = [];
  const afterCommit = options.afterCommit ?? "reject";
  let committed = false;

  const refuseIfCommitted = (): void => {
    if (committed) throw new Error("unit of work already committed");
  };

  const uow: UnitOfWork = {
    async stage(change: StagedChange): Promise<void> {
      const late = committed;
      if (late && afterCommit === "reject") refuseIfCommitted();
      if (late) {
        const target = change.kind === "bulk" ? change.reason : change.path;
        logger
          .debug`Change staged after its unit of work committed, sent to the hook: ${change.kind} ${target}`;
      } else {
        changes.push(Object.freeze({ ...change }));
      }
      if (markDirty === undefined) return;
      const mark = markDirty(
        change.kind === "bulk" ? undefined : change.path,
      );
      if (!late) marks.push(mark);
      await mark;
    },
    async commit(): Promise<void> {
      refuseIfCommitted();
      committed = true;
      // A rejected mark already rejected its own stage call.
      await Promise.allSettled(marks);
      await options.flush?.();
    },
    staged(): readonly StagedChange[] {
      return Object.freeze([...changes]);
    },
  };
  if (markDirty !== undefined) targets.set(uow, markDirty);
  return uow;
}

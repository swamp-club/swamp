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

/** Options for {@link createLegacyUnitOfWork}. */
export interface LegacyUnitOfWorkOptions {
  /**
   * Pushes the marked changes; `commit` awaits it. Required so every caller
   * decides: pass `undefined` only where there is nothing to push
   * (filesystem datastores), because `commit` then pushes nothing.
   */
  flush: (() => Promise<void>) | undefined;
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
 * when one is given. In Phase 1 no production code calls `commit`: the
 * existing flush paths (`acquireModelLocks().flush`, `flushDatastoreSync`,
 * `pushManagedConfigChanges`, serve's `pushChangedToRemote`) keep pushing as
 * they do today. Phase 2 wires `commit` to them.
 */
export function createLegacyUnitOfWork(
  markDirty: MarkDirtyHook | undefined,
  options: LegacyUnitOfWorkOptions,
): UnitOfWork {
  const changes: StagedChange[] = [];
  const marks: Promise<void>[] = [];
  let committed = false;

  const refuseIfCommitted = (): void => {
    if (committed) throw new Error("unit of work already committed");
  };

  return {
    async stage(change: StagedChange): Promise<void> {
      refuseIfCommitted();
      changes.push(Object.freeze({ ...change }));
      if (markDirty === undefined) return;
      const mark = markDirty(
        change.kind === "bulk" ? undefined : change.path,
      );
      marks.push(mark);
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
}

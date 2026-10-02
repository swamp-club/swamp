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
 * The unit of work: the set of changes one business operation makes to the
 * datastore, and the point at which they become durable and visible to
 * other machines.
 *
 * The datastore rework (swamp-club#2865) moves swamp from "write a file,
 * mark it dirty, push later" to "commit the operation's changes through a
 * unit of work". It lands in phases:
 *
 * - **Phase 1.** Repositories stage each change into a unit of work before
 *   they write. The legacy adapter
 *   (`src/infrastructure/persistence/legacy_unit_of_work.ts`) turns every
 *   staged change into exactly the `markDirty` call the repository makes
 *   today, so behaviour does not change.
 * - **Phase 2.** Use cases open a unit of work per operation and commit it.
 *   CLI commands and serve handlers stop marking and pushing themselves.
 * - **Phase 3.** A second adapter commits the staged changes to the datastore
 *   commit log.
 *
 * @module
 */

/**
 * One change a repository is about to make in the datastore.
 *
 * - `write`: the absolute path of a file or directory about to be created or
 *   changed; it exists after the operation.
 * - `remove`: the absolute path of a file or directory about to be removed;
 *   it is gone after the operation.
 * - `bulk`: a change that cannot be attributed to one path. `reason` is a
 *   short fixed string naming the operation (e.g. `"rename tombstone"`),
 *   for diagnostics only.
 *
 * Paths are absolute, as repositories hold them. Turning them into
 * cache-relative paths stays in the composition root's mark hook, so the
 * conversion rules live in one place.
 */
export type StagedChange =
  | { readonly kind: "write"; readonly path: string }
  | { readonly kind: "remove"; readonly path: string }
  | { readonly kind: "bulk"; readonly reason: string };

/**
 * Collects the changes one business operation makes to the datastore and
 * decides when they become durable and visible to others.
 *
 * A unit of work lives for one operation. It is never kept for the life of
 * a process, so the list of staged changes is bounded by that operation.
 * Once committed it is spent: staging or committing again is a programming
 * error, and a caller whose commit failed opens a new unit of work.
 */
export interface UnitOfWork {
  /**
   * Records a change. Called before the write begins, so a crash mid-write
   * still leaves the change recorded (`DatastoreSyncService.markDirty`
   * rule 1). The change is recorded even when forwarding it rejects: the
   * operation attempted it.
   *
   * Changes are ordered by when `stage` is called. Await each call before
   * the write it announces and before staging the next change: the order of
   * bulk and per-path changes is part of the contract.
   */
  stage(change: StagedChange): Promise<void>;
  /**
   * Makes the staged changes durable and visible to others, once. It waits
   * for any `stage` still in flight first, so no change is left behind. The
   * unit is spent as soon as `commit` is called, whether or not it succeeds.
   * Call it once the operation's writes have finished: it does not wait for
   * a write that follows a resolved `stage`.
   */
  commit(): Promise<void>;
  /**
   * The changes staged so far, in staging order. A snapshot: later stage
   * calls, and changes the caller makes to its own objects, do not alter it.
   */
  staged(): readonly StagedChange[];
}

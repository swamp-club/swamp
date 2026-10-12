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
 *   Each CLI command or serve request runs in one root unit that pushes once
 *   when it ends; the use cases' units nest inside it as children that roll
 *   their changes up and never push. CLI commands and serve handlers stop
 *   marking and pushing themselves.
 * - **Phase 3.** A second adapter commits the staged changes to the datastore
 *   commit log. Each adapter binds the units it builds to the repository
 *   context they serve through {@link UnitOfWorkBinding} (swamp-club#3240).
 *
 * @module
 */

import type { MarkDirtyHook } from "./datastore_sync_service.ts";

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
 * It ends once, through {@link UnitOfWork.commit} or
 * {@link UnitOfWork.abandon}. Once ended it is spent: staging or ending it
 * again is a programming error, and a caller whose commit failed opens a new
 * unit of work.
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
   * Ends the unit without completing the operation: the staged changes are
   * not committed. Like {@link UnitOfWork.commit}, it waits for any `stage`
   * still in flight and spends the unit as soon as it is called, whether or
   * not it succeeds. What an adapter does downstream with changes it has
   * already forwarded is the adapter's to document.
   */
  abandon(): Promise<void>;
  /**
   * The changes staged so far, in staging order. A snapshot: later stage
   * calls, and changes the caller makes to its own objects, do not alter it.
   */
  staged(): readonly StagedChange[];
}

/**
 * How a unit of work claims the repository context it serves: decisions 2
 * and 3 of "v3 domain model" in `design/enablers/datastores.md`
 * (swamp-club#3240).
 *
 * A repository context is known by its mark hook: every repository a
 * context builds shares that one function. A repository stages into the
 * ambient unit of work only when the unit is bound to its own hook
 * (`signalChange` in `src/infrastructure/persistence/unit_of_work_scope.ts`).
 * Each adapter binds the units it builds: the legacy adapter, and the v3
 * commit-log adapter. Identity decides, so a unit bound to a wrapper of a
 * hook never takes that hook's changes.
 *
 * A context on a v3 datastore has no fallback for a write made outside
 * every unit bound to it: its hook is marked with {@link requireUnit}, and
 * such a write is refused rather than marked.
 */
export interface UnitOfWorkBinding {
  /**
   * Records that `uow` serves the repository context behind `markDirty`.
   * Throws when `uow` is already bound to another hook.
   */
  bind(uow: UnitOfWork, markDirty: MarkDirtyHook): void;
  /** The hook `uow` is bound to, or undefined when it is bound to none. */
  boundHook(uow: UnitOfWork): MarkDirtyHook | undefined;
  /**
   * Marks the context behind `markDirty` as one whose writes must run in a
   * unit bound to it: a v3 datastore's. Never undone.
   */
  requireUnit(markDirty: MarkDirtyHook): void;
  /** Whether {@link requireUnit} marked `markDirty`. */
  requiresUnit(markDirty: MarkDirtyHook): boolean;
}

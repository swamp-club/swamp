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
 * The process-wide unit-of-work binding registry (swamp-club#3240).
 *
 * `signalChange` (`unit_of_work_scope.ts`) asks it whether the ambient unit
 * serves a repository's context, and whether that context refuses a write
 * outside every unit bound to it. The legacy adapter binds each unit it
 * builds over a hook; the v3 commit-log adapter binds its units and marks
 * its context's hook with `requireUnit`. Both keys are held weakly, so
 * nothing here outlives the units and hooks it describes.
 *
 * The commit-log adapter also registers each unit it builds as a typed
 * stager (swamp-club#3250): {@link typedStagers} is how `stageTyped` hands a
 * repository's typed changes to it, so persistence never imports the
 * dormant commit-log unit. It lives here, not in the domain port, so the
 * `datastore` context never depends on `datastore_v3`.
 *
 * @module
 */

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  UnitOfWork,
  UnitOfWorkBinding,
} from "../../domain/datastore/unit_of_work.ts";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";

const hooks = new WeakMap<UnitOfWork, MarkDirtyHook>();
const required = new WeakSet<MarkDirtyHook>();

/** The one registry every adapter binds through. */
export const unitOfWorkBinding: UnitOfWorkBinding = {
  bind(uow, markDirty) {
    const bound = hooks.get(uow);
    if (bound !== undefined && bound !== markDirty) {
      throw new Error(
        "a unit of work is already bound to another repository context",
      );
    }
    hooks.set(uow, markDirty);
  },
  boundHook: (uow) => hooks.get(uow),
  requireUnit(markDirty) {
    required.add(markDirty);
  },
  requiresUnit: (markDirty) => required.has(markDirty),
};

/** Records one batch of typed changes into the unit it was registered for. */
export type TypedStager = (changes: readonly TypedChange[]) => Promise<void>;

const stagers = new WeakMap<UnitOfWork, TypedStager>();

/**
 * For each unit that takes typed changes, the open unit a write made in its
 * scope belongs to: itself while open, else its nearest open ancestor.
 */
const openTargets = new WeakMap<UnitOfWork, () => UnitOfWork | undefined>();

/**
 * Where a v3 unit reads the version a data name's next version must exceed
 * (swamp-club#3532), and records a version it handed out.
 */
export interface VersionFloorSource {
  floor(partition: string, name: string): Promise<number>;
  claim(partition: string, name: string, version: number): void;
}

const floors = new WeakMap<UnitOfWork, VersionFloorSource>();

/** The version-floor source of each v3 unit that has one. */
export const versionFloors = {
  register(uow: UnitOfWork, source: VersionFloorSource): void {
    floors.set(uow, source);
  },
  of: (uow: UnitOfWork): VersionFloorSource | undefined => floors.get(uow),
};

/** The units that take typed changes: the v3 commit-log adapter's. */
export const typedStagers = {
  register(
    uow: UnitOfWork,
    stage: TypedStager,
    openTarget?: () => UnitOfWork | undefined,
  ): void {
    stagers.set(uow, stage);
    if (openTarget !== undefined) openTargets.set(uow, openTarget);
  },
  stagerOf: (uow: UnitOfWork): TypedStager | undefined => stagers.get(uow),
  /**
   * The open unit a write in `uow`'s scope belongs to (swamp-club#3279):
   * `uow` while it is open, else its nearest open ancestor, else undefined.
   */
  openTargetOf: (uow: UnitOfWork): UnitOfWork | undefined =>
    openTargets.get(uow)?.(),
};

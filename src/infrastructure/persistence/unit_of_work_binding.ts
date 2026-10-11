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
 * @module
 */

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  UnitOfWork,
  UnitOfWorkBinding,
} from "../../domain/datastore/unit_of_work.ts";

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

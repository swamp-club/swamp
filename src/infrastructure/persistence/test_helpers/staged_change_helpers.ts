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

import type { MarkDirtyHook } from "../../../domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../../../domain/datastore/unit_of_work.ts";
import type { TypedChange } from "../../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { createLegacyUnitOfWork } from "../legacy_unit_of_work.ts";
import { typedStagers, unitOfWorkBinding } from "../unit_of_work_binding.ts";

/** Whether `path` exists as a file, directory or link. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * A legacy unit of work over a mark hook that records each mark, for tests
 * that check what a repository stages and marks inside a scope.
 */
export function recordingUnitOfWork(): {
  markDirty: MarkDirtyHook;
  marks: Array<string | undefined>;
  uow: UnitOfWork;
} {
  const marks: Array<string | undefined> = [];
  const markDirty: MarkDirtyHook = (path?: string): Promise<void> => {
    marks.push(path);
    return Promise.resolve();
  };
  const uow = createLegacyUnitOfWork(markDirty, { flush: undefined });
  return { markDirty, marks, uow };
}

/**
 * A v3 hook (one that requires a unit) and a unit bound to it that takes
 * typed changes, recording each staged batch and path change, for tests
 * that check what a repository stages on v3 without a commit store.
 */
export function typedRecordingUnitOfWork(): {
  markDirty: MarkDirtyHook;
  uow: UnitOfWork;
  batches: (readonly TypedChange[])[];
  staged: StagedChange[];
} {
  const markDirty: MarkDirtyHook = () => Promise.resolve();
  unitOfWorkBinding.requireUnit(markDirty);
  const staged: StagedChange[] = [];
  const batches: (readonly TypedChange[])[] = [];
  const uow: UnitOfWork = {
    stage(change) {
      staged.push(change);
      return Promise.resolve();
    },
    commit: () => Promise.resolve(),
    abandon: () => Promise.resolve(),
    staged: () => [...staged],
  };
  unitOfWorkBinding.bind(uow, markDirty);
  typedStagers.register(uow, (changes) => {
    batches.push(changes);
    return Promise.resolve();
  });
  return { markDirty, uow, batches, staged };
}

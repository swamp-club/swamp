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
  UnitOfWork,
  UnitOfWorkBinding,
} from "../../domain/datastore/unit_of_work.ts";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";

const hooks = new WeakMap<UnitOfWork, MarkDirtyHook>();
const required = new WeakSet<MarkDirtyHook>();

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

export type TypedStager = (changes: readonly TypedChange[]) => Promise<void>;

const stagers = new WeakMap<UnitOfWork, TypedStager>();

const openTargets = new WeakMap<UnitOfWork, () => UnitOfWork | undefined>();

export interface VersionFloorSource {
  floor(partition: string, name: string): Promise<number>;
  claim(partition: string, name: string, version: number): void;
  /**
   * records a version directory the unit created, so a recovery of its dropped
   * work sweeps whatever is left in it, however old its files' mtimes
   */
  allocated(dir: string): void;
}

const floors = new WeakMap<UnitOfWork, VersionFloorSource>();

export const versionFloors = {
  register(uow: UnitOfWork, source: VersionFloorSource): void {
    floors.set(uow, source);
  },
  of: (uow: UnitOfWork): VersionFloorSource | undefined => floors.get(uow),
};

const admissions = new WeakMap<UnitOfWork, (key: string) => boolean>();

/**
 * a unit drops a key its filter does not admit, so no commit replays it and the
 * repository makes that write durable itself; a unit with no filter admits
 * every key
 */
export const unitAdmissions = {
  register(uow: UnitOfWork, admits: (key: string) => boolean): void {
    admissions.set(uow, admits);
  },
  of: (uow: UnitOfWork): ((key: string) => boolean) | undefined =>
    admissions.get(uow),
};

const writeSignals = new WeakMap<UnitOfWork, () => void>();

export const unitWrites = {
  register(uow: UnitOfWork, onWrite: () => void): void {
    writeSignals.set(uow, onWrite);
  },
  signal(uow: UnitOfWork): void {
    writeSignals.get(uow)?.();
  },
};

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
  openTargetOf: (uow: UnitOfWork): UnitOfWork | undefined =>
    openTargets.get(uow)?.(),
};

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
import { unitOfWorkBinding } from "./unit_of_work_binding.ts";

/**
 * reject fails a late stage so tests catch writes that escape their use case;
 * forward sends it to the hook like an unwrapped write, so production never
 * fails a command
 */
export type AfterCommitPolicy = "reject" | "forward";

export interface LegacyUnitOfWorkOptions {
  /**
   * required so every caller decides; pass undefined only where nothing needs
   * pushing (filesystem datastores, every child unit)
   */
  flush: (() => Promise<void>) | undefined;
  afterCommit?: AfterCommitPolicy;
  parent?: UnitOfWork;
}

const logger = getSwampLogger(["datastore", "unit-of-work"]);

interface LegacyUnitState {
  isOpen(): boolean;
  parent: UnitOfWork | undefined;
  adopt(change: StagedChange): void;
  track(mark: Promise<void>): void;
  settle(): Promise<void>;
}

const states = new WeakMap<UnitOfWork, LegacyUnitState>();

export function legacyUnitOfWorkTarget(
  uow: UnitOfWork,
): MarkDirtyHook | undefined {
  return states.has(uow) ? unitOfWorkBinding.boundHook(uow) : undefined;
}

export function legacyUnitOfWorkParent(
  uow: UnitOfWork,
): UnitOfWork | undefined {
  return states.get(uow)?.parent;
}

/**
 * a rejected mark already rejected its own stage call, so it is not rethrown
 * here
 */
export async function legacyUnitOfWorkSettled(uow: UnitOfWork): Promise<void> {
  await states.get(uow)?.settle();
}

/**
 * openRepoUnitOfWork and runInRootUnitOfWork resolve the parent through this,
 * so the parent they report and the flush they choose match the unit the
 * adapter builds
 */
export function legacyParentFor(
  markDirty: MarkDirtyHook | undefined,
  candidate: UnitOfWork | undefined,
): UnitOfWork | undefined {
  if (markDirty === undefined || candidate === undefined) return undefined;
  if (legacyUnitOfWorkTarget(candidate) !== markDirty) return undefined;
  const state = states.get(candidate);
  if (state === undefined) return undefined;
  return state.isOpen() ? candidate : nearestOpenAncestor(state.parent);
}

function nearestOpenAncestor(
  parent: UnitOfWork | undefined,
): UnitOfWork | undefined {
  let unit = parent;
  while (unit !== undefined) {
    const state = states.get(unit);
    if (state === undefined) return undefined;
    if (state.isOpen()) return unit;
    unit = state.parent;
  }
  return undefined;
}

/**
 * stage forwards every change to the hook at once and never batches, dedupes,
 * reorders or defers, because markDirty depends on timing and on the order of
 * bulk and per-path marks
 */
export function createLegacyUnitOfWork(
  markDirty: MarkDirtyHook | undefined,
  options: LegacyUnitOfWorkOptions,
): UnitOfWork {
  if (markDirty !== undefined && unitOfWorkBinding.requiresUnit(markDirty)) {
    // a legacy unit forwards each change to the hook, which a v3 context must
    // not use; it commits only through a commit-log unit
    throw new Error(
      "a legacy unit of work cannot serve a v3 repository context; open a " +
        "commit-log unit over it",
    );
  }
  const parent = legacyParentFor(markDirty, options.parent);
  if (parent !== undefined && options.flush !== undefined) {
    throw new Error("a child unit of work cannot flush; its root pushes");
  }
  const parentState = parent === undefined ? undefined : states.get(parent);
  const changes: StagedChange[] = [];
  const marks: Promise<void>[] = [];
  const afterCommit = options.afterCommit ?? "reject";
  let ended: "committed" | "abandoned" | undefined;

  const refuseIfEnded = (): void => {
    if (ended !== undefined) {
      throw new Error(`unit of work already ${ended}`);
    }
  };

  const end = async (as: "committed" | "abandoned"): Promise<void> => {
    refuseIfEnded();
    ended = as;
    // A rejected mark already rejected its own stage call.
    await Promise.allSettled(marks);
    await options.flush?.();
  };

  const state: LegacyUnitState = {
    isOpen: () => ended === undefined,
    parent,
    adopt(change) {
      if (ended === undefined) changes.push(change);
      parentState?.adopt(change);
    },
    track(mark) {
      if (ended === undefined) marks.push(mark);
      parentState?.track(mark);
    },
    async settle() {
      await Promise.allSettled([...marks]);
    },
  };

  const uow: UnitOfWork = {
    async stage(change: StagedChange): Promise<void> {
      const late = ended !== undefined;
      if (late) {
        const ancestor = nearestOpenAncestor(parent);
        if (ancestor !== undefined) return await ancestor.stage(change);
        if (afterCommit === "reject") refuseIfEnded();
        const target = change.kind === "bulk" ? change.reason : change.path;
        logger
          .debug`Change staged after its unit of work ended, sent to the hook: ${change.kind} ${target}`;
      }
      if (!late) state.adopt(Object.freeze({ ...change }));
      if (markDirty === undefined) return;
      const mark = markDirty(
        change.kind === "bulk" ? undefined : change.path,
      );
      if (!late) state.track(mark);
      await mark;
    },
    commit: () => end("committed"),
    abandon: () => end("abandoned"),
    staged(): readonly StagedChange[] {
      return Object.freeze([...changes]);
    },
  };
  states.set(uow, state);
  if (markDirty !== undefined) unitOfWorkBinding.bind(uow, markDirty);
  return uow;
}

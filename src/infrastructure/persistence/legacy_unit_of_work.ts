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
 * What a legacy unit of work does with a change staged after it ended
 * (committed or abandoned).
 *
 * - `"reject"`: `stage` rejects with "unit of work already committed" (or
 *   "abandoned"). Tests use it, so a write that escapes its use case fails
 *   the test.
 * - `"forward"`: `stage` sends the change straight to the hook, as a write
 *   outside any unit of work would, and logs it at debug. Production uses it,
 *   so a write that escapes its use case never fails a command.
 *
 * A child unit hands a late change to its nearest open ancestor before this
 * policy applies, so the root still sees it.
 */
export type AfterCommitPolicy = "reject" | "forward";

/** Options for {@link createLegacyUnitOfWork}. */
export interface LegacyUnitOfWorkOptions {
  /**
   * Pushes the marked changes; `commit` and `abandon` await it. Required so
   * every caller decides: pass `undefined` only where there is nothing to
   * push (filesystem datastores, and every child unit), because the unit
   * then pushes nothing when it ends.
   */
  flush: (() => Promise<void>) | undefined;
  /** Late-stage handling; defaults to `"reject"`. See {@link AfterCommitPolicy}. */
  afterCommit?: AfterCommitPolicy;
  /**
   * The unit that was ambient when this one was opened. The new unit is a
   * child of it when it is an open legacy unit bound to the same hook, or of
   * its nearest open ancestor when it has ended; otherwise the new unit is a
   * root. See {@link legacyParentFor}.
   */
  parent?: UnitOfWork;
}

const logger = getSwampLogger(["datastore", "unit-of-work"]);

/**
 * The hook each legacy unit of work forwards to, by unit. Kept beside the
 * adapter, not on the {@link UnitOfWork} port: which hook a unit belongs to
 * is an adapter detail, and a unit built any other way can never claim one.
 */
const targets = new WeakMap<UnitOfWork, MarkDirtyHook>();

/** What a legacy unit exposes to its children. Adapter-private. */
interface LegacyUnitState {
  /** False once the unit has committed or been abandoned. */
  isOpen(): boolean;
  /** The unit this one rolls up into, if it is a child. */
  parent: UnitOfWork | undefined;
  /**
   * Records a change staged in this unit or a descendant, in this unit while
   * it is open and in every ancestor.
   */
  adopt(change: StagedChange): void;
  /**
   * Tracks the mark sent for an adopted change, so ending this unit or any
   * ancestor waits for it.
   */
  track(mark: Promise<void>): void;
  /**
   * Waits for every mark tracked so far, this unit's and its descendants',
   * without ending the unit.
   */
  settle(): Promise<void>;
}

const states = new WeakMap<UnitOfWork, LegacyUnitState>();

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
 * The unit `uow` rolls up into, when `uow` is a legacy child unit. Undefined
 * for a root and for any other {@link UnitOfWork}.
 */
export function legacyUnitOfWorkParent(
  uow: UnitOfWork,
): UnitOfWork | undefined {
  return states.get(uow)?.parent;
}

/**
 * Waits for every mark `uow` and its descendants sent before the call, as
 * ending the unit does, but leaves it open. A rejected mark already rejected
 * its own stage call, so it is not rethrown here. Resolves at once for any
 * other {@link UnitOfWork}. A root's checkpoint uses it
 * (`runInRootUnitOfWork`, swamp-club#3053).
 */
export async function legacyUnitOfWorkSettled(uow: UnitOfWork): Promise<void> {
  await states.get(uow)?.settle();
}

/**
 * The unit a new unit over `markDirty` rolls up into, given the ambient unit
 * `candidate`: `candidate` itself when it is an open legacy unit bound to
 * that hook, otherwise its nearest open ancestor (an ambient unit can outlive
 * its own end, for work started in its scope that is still running). Undefined
 * when there is none, or the candidate is bound to another hook or not legacy:
 * the new unit is then a root.
 *
 * `openRepoUnitOfWork` and `runInRootUnitOfWork` resolve the parent through
 * this same function, so the parent they report and the flush they choose
 * always match the unit the adapter actually builds.
 */
export function legacyParentFor(
  markDirty: MarkDirtyHook | undefined,
  candidate: UnitOfWork | undefined,
): UnitOfWork | undefined {
  if (markDirty === undefined || candidate === undefined) return undefined;
  if (targets.get(candidate) !== markDirty) return undefined;
  const state = states.get(candidate);
  if (state === undefined) return undefined;
  return state.isOpen() ? candidate : nearestOpenAncestor(state.parent);
}

/** The nearest ancestor of a unit that has not ended yet. */
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
 * `commit` and `abandon` each end the unit: they wait for any mark still in
 * flight, then await `options.flush` when one is given. A legacy unit
 * flushes on abandon too, because its changes have already reached the hook
 * and today's flush paths push them when an operation fails. A Phase 3
 * commit-log unit discards its staged changes on abandon instead; the
 * difference is deliberate, and goes away once nothing is sent before
 * commit. Use-case units (`openRepoUnitOfWork`) have no flush, so the
 * existing flush paths keep pushing; only the root a command or request opens
 * through `runInRootUnitOfWork` carries one.
 *
 * **Root and child units (swamp-club#3032).** A unit created with
 * `options.parent` set to an open legacy unit bound to the same hook is a
 * child. It still forwards each change to the hook itself, at once, and
 * records it in its own `staged()` and in every open ancestor's, so the root
 * sees everything the operation changed. A child's `commit` and `abandon`
 * only spend it: the root decides the push, so a child must not have a
 * flush. A change staged on a spent child goes to its nearest open
 * ancestor; with none, it follows `options.afterCommit`. A spent parent
 * hands the unit to its own nearest open ancestor; with none, or with a
 * parent bound to another hook, the unit is a root.
 *
 * A change staged after the unit ended follows `options.afterCommit`. With
 * `"forward"` it is not recorded in `staged()`: the unit is spent, and the
 * change reaches the hook exactly as it would outside any unit of work.
 */
export function createLegacyUnitOfWork(
  markDirty: MarkDirtyHook | undefined,
  options: LegacyUnitOfWorkOptions,
): UnitOfWork {
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
  if (markDirty !== undefined) targets.set(uow, markDirty);
  states.set(uow, state);
  return uow;
}

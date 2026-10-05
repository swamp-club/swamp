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
 * Units of work bound to a repository context: datastore rework Phase 2
 * (swamp-club#3025, swamp-club#3032).
 *
 * A repository stages into the ambient unit of work only when the unit wraps
 * that repository's exact mark hook (`signalChange` in
 * `unit_of_work_scope.ts`). Every repository a repository context builds
 * shares one hook, `repoContext.markDirty`, so the CLI and serve open units
 * through {@link repoUnitOfWorkFactory} and {@link runInRootUnitOfWork},
 * which pass that instance itself. Never wrap or rebuild the hook: a unit
 * over any other function collects nothing, though marks still reach the
 * sync service.
 *
 * **Root and child units.** A command or request runs in one root unit
 * ({@link runInRootUnitOfWork}) that pushes once when it ends, on every
 * outcome. A unit opened while a unit for the same hook is ambient is that
 * unit's child: it forwards each change as before, rolls it up into the
 * root, and never pushes. A root can also push partway through with
 * `checkpoint()` (swamp-club#3053), which stays off the domain
 * {@link UnitOfWork} port.
 *
 * @module
 */

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import { getSwampLogger } from "../logging/logger.ts";
import {
  createLegacyUnitOfWork,
  legacyParentFor,
  legacyUnitOfWorkSettled,
} from "./legacy_unit_of_work.ts";
import type { RepositoryContext } from "./repository_factory.ts";
import { currentUnitOfWork, runInUnitOfWork } from "./unit_of_work_scope.ts";

/** What production chose for a unit the test seam builds. */
export interface BoundUnitOfWorkOptions {
  /** The push the unit runs when it ends; undefined for every child. */
  flush: (() => Promise<void>) | undefined;
  /**
   * The ambient unit for the same hook, which the new unit rolls up into;
   * undefined for a root.
   */
  parent: UnitOfWork | undefined;
  /**
   * `"root"` for the unit {@link runInRootUnitOfWork} opens, `"use-case"`
   * for one a use case opens through {@link openRepoUnitOfWork}.
   */
  role: "root" | "use-case";
}

/** Builds the unit of work for one operation over the given mark hook. */
export type BoundUnitOfWorkFactory = (
  markDirty: MarkDirtyHook | undefined,
  options: BoundUnitOfWorkOptions,
) => UnitOfWork;

let factoryForTesting: BoundUnitOfWorkFactory | undefined;

const logger = getSwampLogger(["datastore", "unit-of-work"]);

/**
 * The open unit a new unit over `markDirty` rolls up into: the ambient unit,
 * or its nearest open ancestor when it has already ended.
 */
function ambientFor(
  markDirty: MarkDirtyHook | undefined,
): UnitOfWork | undefined {
  return legacyParentFor(markDirty, currentUnitOfWork());
}

function openUnit(
  markDirty: MarkDirtyHook | undefined,
  options: BoundUnitOfWorkOptions,
): UnitOfWork {
  if (factoryForTesting !== undefined) {
    return factoryForTesting(markDirty, options);
  }
  return createLegacyUnitOfWork(markDirty, {
    flush: options.flush,
    afterCommit: "forward",
    parent: options.parent,
  });
}

/**
 * Opens a use case's unit of work over `markDirty`, as production does. Inside
 * a unit for the same hook it is a child; otherwise a root. It has no flush
 * either way, so ending it pushes nothing and the existing flush paths keep
 * pushing. A change staged after it ended goes to an open ancestor, or to the
 * hook, instead of failing the command.
 */
export function openRepoUnitOfWork(
  markDirty: MarkDirtyHook | undefined,
): UnitOfWork {
  return openUnit(markDirty, {
    flush: undefined,
    parent: ambientFor(markDirty),
    role: "use-case",
  });
}

/**
 * The unit-of-work factory for a `LibSwampContext` whose use cases write
 * through `repoContext`'s repositories. Each unit wraps
 * `repoContext.markDirty` itself. With no hook (filesystem datastores,
 * read-only contexts) the unit is unbound and stages nothing.
 */
export function repoUnitOfWorkFactory(
  repoContext: Pick<RepositoryContext, "markDirty">,
): () => UnitOfWork {
  return () => openRepoUnitOfWork(repoContext.markDirty);
}

/**
 * What composition code gets of its root: it stages hand marks, can read
 * what was staged, and can push partway through, but never ends the root;
 * {@link runInRootUnitOfWork} does.
 */
export interface RootUnitOfWork extends Pick<UnitOfWork, "stage" | "staged"> {
  /**
   * A mid-operation push (swamp-club#3053), not the catalog's WAL
   * checkpoint (`CatalogStore.checkpoint`). Waits for every mark the root
   * and its children sent before the call, as ending the root does, then
   * awaits the `checkpoint` option the root was opened with. The root stays
   * open and still runs its flush once when it ends. The wait covers legacy
   * units only: a unit a test factory builds any other way
   * (`useUnitOfWorkFactoryForTesting`) is not waited on.
   *
   * Throws when the root was opened without a `checkpoint` option, when the
   * call that opened it became a child of an outer root (the outer root owns
   * the checkpoint), and after the root has ended. A failing checkpoint
   * push rejects here, inside `fn`, as a direct push would.
   *
   * It lives here and on the legacy adapter, not on the domain
   * {@link UnitOfWork} port: what a Phase 3 commit-log unit means by a
   * partial commit is a Phase 3 decision.
   */
  checkpoint(): Promise<void>;
}

/** How the operation a root ran ended, as its flush sees it. */
export interface RootFlushOutcome {
  /** `fn` resolved; false when it threw. */
  completed: boolean;
}

/** Options for {@link runInRootUnitOfWork}. */
export interface RootUnitOfWorkOptions {
  /**
   * The push the root runs once when it ends, given how `fn` ended. It runs
   * on every outcome unless `pushWhen` says otherwise.
   */
  flush: ((outcome: RootFlushOutcome) => Promise<void>) | undefined;
  /**
   * When the flush runs: `"always"` (the default) on every outcome, or
   * `"completed"` only when `fn` resolved, for an operation that pushed
   * only on success. A flush whose push depends on more than the outcome
   * reads `outcome.completed` itself instead.
   */
  pushWhen?: "always" | "completed";
  /**
   * The mid-operation push `root.checkpoint()` runs; absent when the
   * operation never pushes partway through. See
   * {@link RootUnitOfWork.checkpoint}.
   */
  checkpoint?: () => Promise<void>;
  /**
   * Receives the push error when `fn` threw and the push failed too; `fn`'s
   * error is the one rethrown. Without it the push error is logged at warn.
   */
  onFlushError?: (error: unknown) => void;
}

/**
 * Runs one command or request in a root unit of work over
 * `repoContext.markDirty`, and pushes once when it ends.
 *
 * - `fn` runs with the root ambient, so every use case it runs opens a child
 *   that rolls up into the root. It receives the root so composition code
 *   stages the changes it makes outside repositories through it: a bare mark
 *   becomes `root.stage({ kind: "bulk", reason: "<command>" })`, and a
 *   per-path mark `root.stage({ kind: "write" | "remove", path })`. The
 *   legacy root forwards each as the identical hook call. `fn` never ends
 *   the root: it is typed {@link RootUnitOfWork}, without `commit` or
 *   `abandon`.
 * - The root always ends: `commit` when `fn` resolved, `abandon` when it
 *   threw. A legacy root flushes either way, as today's paths push on every
 *   outcome, unless `pushWhen: "completed"` skips the flush when `fn` threw.
 *   The flush receives the outcome either way.
 * - When `fn` threw and the flush also throws, `fn`'s error is rethrown and
 *   the flush error goes to `onFlushError` (or a warn log). When `fn`
 *   resolved and the flush throws, the flush error is thrown.
 * - Called while an open unit for the same hook is ambient (or an ended one
 *   with an open ancestor), it opens a child of that open unit, which never
 *   pushes; the outer root pushes. Such a nested call must pass
 *   `flush: undefined`: one given a push throws, rather than drop that push
 *   silently. With no open unit for the hook it is a root and flushes.
 * - The same holds for `checkpoint`: a nested call given one throws, and
 *   `checkpoint()` on a nested call's child throws, so the outer root owns
 *   every mid-operation push.
 */
export async function runInRootUnitOfWork<T>(
  repoContext: Pick<RepositoryContext, "markDirty">,
  options: RootUnitOfWorkOptions,
  fn: (root: RootUnitOfWork) => Promise<T>,
): Promise<T> {
  const markDirty = repoContext.markDirty;
  const parent = ambientFor(markDirty);
  if (parent !== undefined && options.flush !== undefined) {
    throw new Error(
      "a root unit of work was opened inside another for the same hook with " +
        "its own push; give that push to the outer root, or run it outside",
    );
  }
  if (parent !== undefined && options.checkpoint !== undefined) {
    throw new Error(
      "a root unit of work was opened inside another for the same hook with " +
        "its own checkpoint; give that checkpoint to the outer root",
    );
  }
  const flush = options.flush;
  const pushWhen = options.pushWhen ?? "always";
  let completed = false;
  const root = openUnit(markDirty, {
    flush: flush === undefined ? undefined : async () => {
      if (pushWhen === "completed" && !completed) return;
      await flush({ completed });
    },
    parent,
    role: "root",
  });
  let ended = false;
  const view: RootUnitOfWork = {
    stage: (change) => root.stage(change),
    staged: () => root.staged(),
    async checkpoint() {
      if (ended) {
        throw new Error("checkpoint called after its root unit of work ended");
      }
      if (parent !== undefined) {
        throw new Error(
          "checkpoint called on a nested root unit of work, which is a child " +
            "of the outer root; the outer root owns the checkpoint",
        );
      }
      if (options.checkpoint === undefined) {
        throw new Error(
          "checkpoint called on a root unit of work opened without a " +
            "checkpoint option",
        );
      }
      await legacyUnitOfWorkSettled(root);
      await options.checkpoint();
    },
  };
  let value: T;
  try {
    value = await runInUnitOfWork(root, () => fn(view));
  } catch (error) {
    ended = true;
    try {
      await root.abandon();
    } catch (flushError) {
      if (options.onFlushError !== undefined) {
        options.onFlushError(flushError);
      } else {
        logger
          .warn`Push after a failed operation also failed: ${flushError}`;
      }
    }
    throw error;
  }
  ended = true;
  completed = true;
  await root.commit();
  return value;
}

/**
 * Test seam: makes {@link openRepoUnitOfWork} and {@link runInRootUnitOfWork}
 * build units with `factory` until the returned function is called.
 * `factory` receives the exact hook, flush and parent production would use,
 * so the seam can observe units and choose their late-stage policy but
 * cannot change what they bind to. Throws when a factory is already
 * installed. Only tests may call it
 * (`integration/datastore_write_seams_rules_test.ts`).
 */
export function useUnitOfWorkFactoryForTesting(
  factory: BoundUnitOfWorkFactory,
): () => void {
  if (factoryForTesting !== undefined) {
    throw new Error("a unit-of-work test factory is already installed");
  }
  factoryForTesting = factory;
  return () => {
    if (factoryForTesting === factory) factoryForTesting = undefined;
  };
}

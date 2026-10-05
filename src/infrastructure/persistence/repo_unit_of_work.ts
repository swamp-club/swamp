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
 * root, and never pushes.
 *
 * @module
 */

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import { getSwampLogger } from "../logging/logger.ts";
import {
  createLegacyUnitOfWork,
  legacyParentFor,
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
 * What composition code gets of its root: it stages hand marks and can read
 * what was staged, but never ends the root; {@link runInRootUnitOfWork} does.
 */
export type RootUnitOfWork = Pick<UnitOfWork, "stage" | "staged">;

/** Options for {@link runInRootUnitOfWork}. */
export interface RootUnitOfWorkOptions {
  /** The push the root runs once when it ends, on every outcome. */
  flush: (() => Promise<void>) | undefined;
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
 *   outcome.
 * - When `fn` threw and the flush also throws, `fn`'s error is rethrown and
 *   the flush error goes to `onFlushError` (or a warn log). When `fn`
 *   resolved and the flush throws, the flush error is thrown.
 * - Called while an open unit for the same hook is ambient (or an ended one
 *   with an open ancestor), it opens a child of that open unit without a
 *   flush instead of a second root, so a nested call never pushes twice; the
 *   outer root pushes. With no open unit for the hook it is a root and
 *   flushes.
 */
export async function runInRootUnitOfWork<T>(
  repoContext: Pick<RepositoryContext, "markDirty">,
  options: RootUnitOfWorkOptions,
  fn: (root: RootUnitOfWork) => Promise<T>,
): Promise<T> {
  const markDirty = repoContext.markDirty;
  const parent = ambientFor(markDirty);
  const root = openUnit(markDirty, {
    flush: parent === undefined ? options.flush : undefined,
    parent,
    role: "root",
  });
  let value: T;
  try {
    value = await runInUnitOfWork(root, () => fn(root));
  } catch (error) {
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

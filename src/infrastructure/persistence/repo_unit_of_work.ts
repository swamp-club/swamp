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
 * (swamp-club#3025).
 *
 * A repository stages into the ambient unit of work only when the unit wraps
 * that repository's exact mark hook (`signalChange` in
 * `unit_of_work_scope.ts`). Every repository a repository context builds
 * shares one hook, `repoContext.markDirty`, so the CLI and serve open units
 * through {@link repoUnitOfWorkFactory}, which passes that instance itself.
 * Never wrap or rebuild the hook: a unit over any other function collects
 * nothing, though marks still reach the sync service.
 *
 * @module
 */

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import { createLegacyUnitOfWork } from "./legacy_unit_of_work.ts";
import type { RepositoryContext } from "./repository_factory.ts";

/** Builds the unit of work for one operation over the given mark hook. */
export type BoundUnitOfWorkFactory = (
  markDirty: MarkDirtyHook | undefined,
) => UnitOfWork;

let factoryForTesting: BoundUnitOfWorkFactory | undefined;

/**
 * Opens a unit of work over `markDirty`, as production does: no flush, so
 * commit pushes nothing and the existing flush paths keep pushing, and a
 * change staged after commit goes to the hook instead of failing the
 * command.
 */
export function openRepoUnitOfWork(
  markDirty: MarkDirtyHook | undefined,
): UnitOfWork {
  if (factoryForTesting !== undefined) return factoryForTesting(markDirty);
  return createLegacyUnitOfWork(markDirty, {
    flush: undefined,
    afterCommit: "forward",
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
 * Test seam: makes {@link openRepoUnitOfWork} build units with `factory`
 * until the returned function is called. `factory` receives the exact hook
 * production would bind, so the seam can observe units and choose their
 * late-stage policy but cannot change what they bind to. Throws when a
 * factory is already installed. Only tests may call it
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

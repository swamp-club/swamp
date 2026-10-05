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
 * Runs a command that took the global lock in a root unit of work whose
 * flush is the coordinator's push (swamp-club#3055).
 */

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  type RootUnitOfWork,
  runInRootUnitOfWork,
} from "../infrastructure/persistence/repo_unit_of_work.ts";
import { pushGlobalLockAtEnd } from "./push_paths.ts";

/**
 * Runs `fn`, the rest of a command that opened its repository with
 * `requireInitializedRepo`, in a root unit of work over
 * `repoContext.markDirty` whose flush is the global lock's coordinator push
 * ({@link pushGlobalLockAtEnd}).
 *
 * The push and lock release happen when `fn` ends, on every outcome, where
 * the `flushDatastoreSync()` teardown in `src/cli/mod.ts` made them before;
 * that teardown stays as a safety net and finds nothing left to flush. As
 * there, a push timeout after `fn` resolved is thrown, and one after `fn`
 * threw is dropped silently so `fn`'s error wins. Other push errors are
 * logged at warn by the coordinator and never thrown.
 */
export function runInCoordinatorRoot<T>(
  repoContext: Pick<RepositoryContext, "markDirty">,
  fn: (root: RootUnitOfWork) => Promise<T>,
): Promise<T> {
  return runInRootUnitOfWork(
    repoContext,
    { flush: pushGlobalLockAtEnd },
    fn,
  );
}

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
  commitsThroughCommitLog,
  type RootUnitOfWork,
  runInRootUnitOfWork,
} from "../infrastructure/persistence/repo_unit_of_work.ts";
import { pushGlobalLockAtEnd } from "../infrastructure/persistence/push_paths.ts";
import { openOutputHold } from "./committed_output.ts";

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
 *
 * On v3, what the command prints waits for the root's commit and is dropped
 * when it does not land (swamp-club#3759).
 */
export async function runInCoordinatorRoot<T>(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  fn: (root: RootUnitOfWork) => Promise<T>,
): Promise<T> {
  const hold = commitsThroughCommitLog(repoContext)
    ? openOutputHold("held")
    : undefined;
  let committed = false;
  try {
    return await runInRootUnitOfWork(
      repoContext,
      {
        flush: pushGlobalLockAtEnd,
        ...(hold === undefined ? {} : {
          commitLog: {
            onEnded: (rootCommitted: boolean) => {
              committed = rootCommitted;
            },
          },
        }),
      },
      fn,
    );
  } finally {
    hold?.end(committed);
  }
}

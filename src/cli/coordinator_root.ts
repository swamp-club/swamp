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

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  commitsThroughCommitLog,
  type RootUnitOfWork,
  runInRootUnitOfWork,
} from "../infrastructure/persistence/repo_unit_of_work.ts";
import { pushGlobalLockAtEnd } from "../infrastructure/persistence/push_paths.ts";
import { openOutputHold, type OutputHoldMode } from "./committed_output.ts";

/**
 * the push and lock release happen when fn ends, on every outcome; a push
 * timeout after fn resolved is thrown, one after fn threw is dropped so fn's
 * error wins
 */
export async function runInCoordinatorRoot<T>(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  fn: (root: RootUnitOfWork) => Promise<T>,
  output: OutputHoldMode = "held",
): Promise<T> {
  const hold = commitsThroughCommitLog(repoContext)
    ? openOutputHold(output)
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

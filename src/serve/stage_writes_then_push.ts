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
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";

/**
 * re-marks paths just before the push so one that landed in between leaves none
 * behind; each is a per-path write, never a bare mark that would walk the whole
 * cache. Pushes only once every path is staged
 */
export async function stageWritesThenPush(
  repoContext: Pick<RepositoryContext, "markDirty">,
  paths: readonly string[],
  options: { flush: () => Promise<unknown> },
): Promise<void> {
  await runInRootUnitOfWork(repoContext, {
    flush: async () => {
      await options.flush();
    },
    pushWhen: "completed",
  }, async (root) => {
    for (const path of paths) {
      await root.stage({ kind: "write", path });
    }
  });
}

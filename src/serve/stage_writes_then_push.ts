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
 * Re-marks `paths` and then pushes once, through a root unit of work over
 * `repoContext.markDirty` whose flush is `options.flush` (swamp-club#3034).
 *
 * Serve's device auth mint, grant publishing and `access.reload` re-mark the
 * paths they wrote just before their push, so a push that landed in between
 * cannot leave a path behind. Each path is staged as a per-path write, in
 * order, never as a bare mark, which would turn the push into a walk of the
 * whole cache (swamp-club#2408, swamp-club#2415).
 *
 * The push runs only once every path was staged (`pushWhen: "completed"`). A
 * legacy root also flushes when it is abandoned, but a mark that failed
 * skipped the push before. The mark's error is thrown; so is the push's, and
 * the caller handles both as it did. With no paths it still pushes once.
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

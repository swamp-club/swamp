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
 * Runs a CLI command's write section in a root unit of work
 * (swamp-club#3033). The root's flush is the push the command performs
 * today, and the command's model locks are released after the root has
 * ended, as `ModelLockResult.flush()` released them after its push.
 */

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  type RootUnitOfWork,
  runInRootUnitOfWork,
} from "../infrastructure/persistence/repo_unit_of_work.ts";

/** Options for {@link runCommandInRootUnit}. */
export interface CommandRootUnitOptions {
  /**
   * The push the command performs today, run as the root's flush; undefined
   * when the command pushes nothing on this path.
   */
  push: (() => Promise<void>) | undefined;
  /**
   * When the push runs. `"always"` (the default) pushes on every outcome, as
   * a push in a `finally` does. `"completed"` pushes only when `fn`
   * resolved, as a push that follows the mutation in sequence does.
   */
  pushWhen?: "always" | "completed";
  /** Releases the command's model locks after the root has ended. */
  release?: () => Promise<void>;
  /**
   * Receives the cleanup error: the push error, or the release error, which
   * replaces it as a `finally` would. Without it a cleanup error is thrown
   * when `fn` resolved, and logged at warn when `fn` threw, so it never
   * hides `fn`'s error. When given, whatever it throws propagates.
   */
  onCleanupError?: (error: unknown) => void;
}

const logger = getSwampLogger(["cli", "root-unit"]);

/**
 * Runs `fn` in a root unit of work over `repoContext.markDirty`, then
 * releases the command's locks.
 *
 * - `fn` receives the root, so a hand mark becomes
 *   `root.stage({ kind: "bulk", reason })`; the legacy root forwards it as
 *   the identical `markDirty()` call. Use cases `fn` runs open children of
 *   the root.
 * - The root's flush runs `options.push` once when the root ends (subject to
 *   `pushWhen`). Its error is held until the locks are released, so the
 *   release always runs and the push error reaches the same handler a
 *   combined push-then-release did.
 */
export async function runCommandInRootUnit<T>(
  repoContext: Pick<RepositoryContext, "markDirty">,
  options: CommandRootUnitOptions,
  fn: (root: RootUnitOfWork) => Promise<T>,
): Promise<T> {
  const push = options.push;
  const pushWhen = options.pushWhen ?? "always";
  let completed = false;
  let cleanup: { error: unknown } | undefined;
  const flush = push === undefined ? undefined : async () => {
    if (pushWhen === "completed" && !completed) return;
    try {
      await push();
    } catch (error) {
      cleanup = { error };
    }
  };

  let outcome: { value: T } | { error: unknown };
  try {
    outcome = {
      value: await runInRootUnitOfWork(repoContext, { flush }, async (root) => {
        const value = await fn(root);
        completed = true;
        return value;
      }),
    };
  } catch (error) {
    outcome = { error };
  }

  if (options.release !== undefined) {
    try {
      await options.release();
    } catch (error) {
      cleanup = { error };
    }
  }

  if (cleanup !== undefined) {
    if (options.onCleanupError !== undefined) {
      options.onCleanupError(cleanup.error);
    } else if ("error" in outcome) {
      logger.warn`Failed to push changes to remote datastore: ${cleanup.error}`;
    } else {
      throw cleanup.error;
    }
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

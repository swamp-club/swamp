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

import {
  DataVersionConflictError,
  ModelLockLostError,
} from "../domain/datastore/datastore_sync_service.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  type CheckpointOptions,
  commitsThroughCommitLog,
  type RootFlushOutcome,
  type RootUnitOfWork,
  runInRootUnitOfWork,
} from "../infrastructure/persistence/repo_unit_of_work.ts";
import { openOutputHold, type OutputHoldMode } from "./committed_output.ts";

/** Options for {@link runCommandInRootUnit}. */
export interface CommandRootUnitOptions {
  /**
   * The push the command performs today, run as the root's flush and given
   * how `fn` ended; undefined when the command pushes nothing on this path.
   */
  push: ((outcome: RootFlushOutcome) => Promise<void>) | undefined;
  /**
   * When the push runs. `"always"` (the default) pushes on every outcome, as
   * a push in a `finally` does. `"completed"` pushes only when `fn`
   * resolved, as a push that follows the mutation in sequence does.
   */
  pushWhen?: "always" | "completed";
  /**
   * The mid-command push the command performs today, run by
   * `root.checkpoint()` (swamp-club#3053). Its error rejects inside `fn`, as
   * the direct call did; it never reaches `onCleanupError`.
   */
  checkpoint?: (options: CheckpointOptions) => Promise<number | void>;
  /** Releases the command's model locks after the root has ended. */
  release?: () => Promise<void>;
  /**
   * Receives the cleanup error: the push error, or the release error, which
   * replaces it as a `finally` would. Without it a cleanup error is thrown
   * when `fn` resolved, and logged at warn when `fn` threw, so it never
   * hides `fn`'s error. When given, whatever it throws propagates.
   *
   * Two push errors never reach it when `fn` resolved: a
   * {@link ModelLockLostError} or {@link DataVersionConflictError} is
   * thrown, so a command whose push was refused after its model lock was
   * lost (swamp-club#3373), or because another clone wrote the same data
   * version (swamp-club#3934), fails.
   */
  onCleanupError?: (error: unknown) => void;
  /**
   * How a v3 root holds the command's stdout until it commits
   * (swamp-club#3759): `"held"` (the default) from the start, or
   * `"live-until-outcome"` for a streaming command in log mode, which wraps
   * its handlers in `holdFromOutcome`. A v2 root holds nothing.
   */
  output?: OutputHoldMode;
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
 *   `pushWhen`, which the root applies). Its error is held until the locks
 *   are released, so the release always runs and the push error reaches the
 *   same handler a combined push-then-release did.
 */
export async function runCommandInRootUnit<T>(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  options: CommandRootUnitOptions,
  fn: (root: RootUnitOfWork) => Promise<T>,
): Promise<T> {
  const push = options.push;
  let cleanup: { error: unknown } | undefined;
  let refused: ModelLockLostError | DataVersionConflictError | undefined;
  const flush = push === undefined
    ? undefined
    : async (outcome: RootFlushOutcome) => {
      try {
        await push(outcome);
      } catch (error) {
        if (
          error instanceof ModelLockLostError ||
          error instanceof DataVersionConflictError
        ) refused = error;
        cleanup = { error };
      }
    };

  // What the command prints waits for its v3 root's commit.
  const hold = commitsThroughCommitLog(repoContext)
    ? openOutputHold(options.output ?? "held")
    : undefined;
  let committed = false;
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = {
      value: await runInRootUnitOfWork(repoContext, {
        flush,
        pushWhen: options.pushWhen,
        checkpoint: options.checkpoint,
        ...(hold === undefined ? {} : {
          commitLog: {
            onEnded: (rootCommitted: boolean) => {
              committed = rootCommitted;
            },
          },
        }),
      }, fn),
    };
  } catch (error) {
    outcome = { error };
  }
  hold?.end(committed);

  if (options.release !== undefined) {
    try {
      await options.release();
    } catch (error) {
      cleanup = { error };
    }
  }

  // The refused writes were not pushed, so a command that resolved must not
  // exit as if they were published; a release error after it is only logged.
  if (refused !== undefined && !("error" in outcome)) {
    if (cleanup !== undefined && cleanup.error !== refused) {
      logger.warn`Failed to release locks: ${cleanup.error}`;
    }
    throw refused;
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

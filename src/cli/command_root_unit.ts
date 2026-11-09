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

export interface CommandRootUnitOptions {
  push: ((outcome: RootFlushOutcome) => Promise<void>) | undefined;
  /**
   * "completed" pushes only when fn resolved; "always" pushes on every outcome,
   * like a push in a finally.
   */
  pushWhen?: "always" | "completed";
  /**
   * an error from the checkpoint push rejects inside fn and never reaches
   * onCleanupError.
   */
  checkpoint?: (options: CheckpointOptions) => Promise<number | void>;
  release?: () => Promise<void>;
  /** a lease the root's final commits end with them, sparing a release */
  releaseWithEnd?: string;
  /**
   * without it a cleanup error is thrown when fn resolved and only logged when
   * fn threw, so it never hides fn's error; a lost model lock or data version
   * conflict is always thrown.
   */
  onCleanupError?: (error: unknown) => void;
  /**
   * "held" holds stdout from the start; "live-until-outcome" is for streaming
   * log-mode commands. A v2 root holds nothing.
   */
  output?: OutputHoldMode;
  /**
   * a refusal thrown after the root committed (a config edit conflict) must
   * not follow the result it refused
   */
  outputOnlyOnSuccess?: boolean;
}

const logger = getSwampLogger(["cli", "root-unit"]);

/**
 * the push error is held until the locks are released, so the release always
 * runs.
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
        ...(hold === undefined && options.releaseWithEnd === undefined ? {} : {
          commitLog: {
            ...(hold === undefined ? {} : {
              onEnded: (rootCommitted: boolean) => {
                committed = rootCommitted;
              },
            }),
            ...(options.releaseWithEnd === undefined
              ? {}
              : { releaseWithEnd: options.releaseWithEnd }),
          },
        }),
      }, fn),
    };
  } catch (error) {
    outcome = { error };
  }
  hold?.end(
    committed && !(options.outputOnlyOnSuccess === true && "error" in outcome),
  );

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

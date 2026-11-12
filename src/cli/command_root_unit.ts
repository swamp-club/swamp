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

import { toPushFailure } from "../domain/datastore/datastore_sync_service.ts";
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
   * gets a failed release, and a failed push only when fn threw, so neither
   * hides fn's error; a push that failed after fn resolved is always thrown.
   * Without it a failed release is thrown when fn resolved and logged when fn
   * threw.
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
  // kept apart: a release that fails after a failed push must not replace it
  let pushFailure: { error: unknown } | undefined;
  let releaseFailure: { error: unknown } | undefined;
  const flush = push === undefined
    ? undefined
    : async (outcome: RootFlushOutcome) => {
      try {
        await push(outcome);
      } catch (error) {
        pushFailure = { error };
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
      releaseFailure = { error };
    }
  }

  // The writes did not reach the datastore, so a command that resolved must
  // not exit as if they were published; a release error after it is only logged.
  if (pushFailure !== undefined && !("error" in outcome)) {
    if (releaseFailure !== undefined) {
      logger.warn`Failed to release locks: ${releaseFailure.error}`;
    }
    throw toPushFailure(pushFailure.error);
  }

  if (pushFailure !== undefined) {
    if (options.onCleanupError !== undefined) {
      options.onCleanupError(pushFailure.error);
    } else {
      logger
        .warn`Failed to push changes to remote datastore: ${pushFailure.error}`;
    }
  }
  if (releaseFailure !== undefined) {
    if (options.onCleanupError !== undefined) {
      options.onCleanupError(releaseFailure.error);
    } else if ("error" in outcome) {
      logger.warn`Failed to release locks: ${releaseFailure.error}`;
    } else {
      throw releaseFailure.error;
    }
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

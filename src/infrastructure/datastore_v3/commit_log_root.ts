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

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import { rethrowUnrecordedEnd } from "../../domain/datastore/unit_of_work.ts";
import {
  type CommitLogUnitOfWork,
  CommitUnreachableError,
  PartitionsRefusedError,
  RunPartlyCommittedError,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { unitOfWorkBinding } from "../persistence/unit_of_work_binding.ts";
import {
  currentUnitOfWork,
  runInUnitOfWork,
} from "../persistence/unit_of_work_scope.ts";
import {
  commitLogParentFor,
  type CommitLogUnitOptions,
  createCommitLogUnitOfWork,
  failedReachingStorage,
} from "./commit_log_unit_of_work.ts";

const logger = getSwampLogger(["datastore", "unit-of-work"]);

export type CommitLogOutcome<T> =
  | { readonly completed: true; readonly value: T }
  | { readonly completed: false; readonly error: unknown };

export type CommitLogDisposition = "commit" | "discard";

export interface CommitLogRootOptions<T>
  extends Omit<CommitLogUnitOptions, "parent"> {
  /**
   * by default commits when fn resolves and discards when it throws; a workflow
   * run passes runOutcomeDisposition
   */
  readonly disposition?: (outcome: CommitLogOutcome<T>) => CommitLogDisposition;
  /**
   * a committing root checkpoints first; on a refusal this runs with the root
   * ambient to re-save held runs with refused steps failed, then it commits and
   * throws the refusal. A child never runs it
   */
  readonly onRefused?: (error: PartitionsRefusedError) => Promise<void>;
  /**
   * true when the root's commit resolved, whether fn resolved or threw; false
   * when it was discarded or its end failed. A command prints what it held only
   * on true
   */
  readonly onEnded?: (committed: boolean) => void;
}

/**
 * stage refuses the path-only changes a v2 root takes
 * (PathOnlyChangeRefusedError), so v2-style code fails loudly on v3 rather than
 * losing its change
 */
export type CommitLogRoot = Pick<
  CommitLogUnitOfWork,
  "stage" | "staged" | "stageOp" | "stageOps" | "stagedOps" | "checkpoint"
>;

export function defaultDisposition<T>(
  outcome: CommitLogOutcome<T>,
): CommitLogDisposition {
  return outcome.completed ? "commit" : "discard";
}

export const RUN_COMMIT_STATUSES = [
  "succeeded",
  "failed",
  "suspended",
  "cancelled",
] as const;

/**
 * a run's root commits when it ends succeeded, failed, suspended or cancelled
 * and discards on an error; fn must resolve with the terminal status, since a
 * throw discards back to the last checkpoint
 */
export function runOutcomeDisposition(
  outcome: CommitLogOutcome<{ readonly status: string }>,
): CommitLogDisposition {
  return outcome.completed &&
      (RUN_COMMIT_STATUSES as readonly string[]).includes(outcome.value.status)
    ? "commit"
    : "discard";
}

/**
 * inside an open unit for the same hook the root is its child and changes roll
 * up; when fn threw its error is rethrown and an error ending the root is only
 * logged at warn
 */
export async function runInCommitLogRoot<T>(
  repoContext: { readonly markDirty?: MarkDirtyHook },
  options: CommitLogRootOptions<T>,
  fn: (root: CommitLogRoot) => Promise<T>,
): Promise<T> {
  const markDirty = repoContext.markDirty;
  if (markDirty === undefined) {
    throw new Error(
      "a commit-log root needs the repository context's mark hook, which " +
        "identifies the context",
    );
  }
  unitOfWorkBinding.requireUnit(markDirty);
  const {
    disposition = defaultDisposition,
    onRefused,
    onEnded,
    ...unitOptions
  } = options;
  const parent = commitLogParentFor(markDirty, currentUnitOfWork());
  const root = createCommitLogUnitOfWork(markDirty, { ...unitOptions, parent });
  const view: CommitLogRoot = {
    stage: (change) => root.stage(change),
    staged: () => root.staged(),
    stageOp: (change) => root.stageOp(change),
    stageOps: (changes) => root.stageOps(changes),
    stagedOps: () => root.stagedOps(),
    checkpoint: () => root.checkpoint(),
  };
  // Whether the root's commit resolved, which `onEnded` is told once.
  let committed = false;
  try {
    let value: T;
    try {
      value = await runInUnitOfWork(root, () => fn(view));
    } catch (error) {
      try {
        if (disposition({ completed: false, error }) === "commit") {
          await root.commit();
          committed = true;
        } else {
          await root.abandon();
        }
      } catch (endError) {
        // An end that could not record the failure says so instead of it.
        rethrowUnrecordedEnd(endError, error);
        // an end that could not reach the storage means nothing of the
        // operation, its failure included, was committed, beyond the runs a
        // checkpoint committed
        if (
          endError instanceof CommitUnreachableError ||
          endError instanceof RunPartlyCommittedError
        ) {
          throw endError.during(error);
        }
        logger
          .warn`Ending a commit-log unit of work after a failed operation also failed: ${endError}`;
      }
      throw error;
    }
    if (disposition({ completed: true, value }) !== "commit") {
      await root.abandon();
      return value;
    }
    const refused = onRefused === undefined || parent !== undefined
      ? undefined
      : await settleRefusals(root, onRefused, unitOptions.endRelease);
    await root.commit();
    committed = true;
    if (refused !== undefined) {
      refusalsThrownAfterCommit.add(refused);
      throw refused;
    }
    return value;
  } finally {
    onEnded?.(committed);
  }
}

const refusalsThrownAfterCommit = new WeakSet<PartitionsRefusedError>();

/**
 * any other error, a refusal the root's own commit threw included, may have
 * left the root uncommitted
 */
export function wasThrownAfterCommit(error: unknown): boolean {
  return error instanceof PartitionsRefusedError &&
    refusalsThrownAfterCommit.has(error);
}

/**
 * another checkpoint error is retried a few times, then left to the commit,
 * which retries what is pending and surfaces it
 */
async function settleRefusals(
  root: CommitLogUnitOfWork,
  onRefused: (error: PartitionsRefusedError) => Promise<void>,
  release: string | undefined,
): Promise<PartitionsRefusedError | undefined> {
  // A transient failure leaves its partition pending; checkpoint again, so a
  // refusal behind it is met here, where it can be settled, rather than at
  // the commit, which would lose the held run records.
  for (let attempt = 1;; attempt++) {
    try {
      // the root's last commits, so they may end its lease; a refusal keeps it
      await root.checkpoint(release === undefined ? undefined : { release });
      return undefined;
    } catch (error) {
      if (error instanceof PartitionsRefusedError) {
        return await settle(root, onRefused, error);
      }
      // cut off from the storage before its append, a checkpoint meets no
      // refusal and another would wait out the same retries; the commit says
      // the storage is unreachable
      if (failedReachingStorage(error)) return undefined;
      if (attempt === SETTLE_CHECKPOINT_ATTEMPTS) return undefined;
    }
  }
}

const SETTLE_CHECKPOINT_ATTEMPTS = 3;

async function settle(
  root: CommitLogUnitOfWork,
  onRefused: (error: PartitionsRefusedError) => Promise<void>,
  error: PartitionsRefusedError,
): Promise<PartitionsRefusedError> {
  try {
    await runInUnitOfWork(root, () => onRefused(error));
  } catch (callbackError) {
    logger
      .warn`Settling a refused datastore commit failed, so its root was discarded: ${error.message}`;
    try {
      await root.abandon();
    } catch (endError) {
      rethrowUnrecordedEnd(endError, callbackError);
      logger
        .warn`Ending a commit-log unit of work after a failed operation also failed: ${endError}`;
    }
    throw callbackError;
  }
  root.acknowledgeRefusals();
  return error;
}

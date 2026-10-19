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
 * Opens a commit-log root over a v3 repository context: the v3 counterpart
 * of `runInRootUnitOfWork` (swamp-club#3240). Dormant: only tests call it
 * until the v3 opt-in.
 *
 * @module
 */

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import { rethrowUnrecordedEnd } from "../../domain/datastore/unit_of_work.ts";
import {
  type CommitLogUnitOfWork,
  PartitionsRefusedError,
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
} from "./commit_log_unit_of_work.ts";

const logger = getSwampLogger(["datastore", "unit-of-work"]);

/** How the operation a commit-log root ran ended. */
export type CommitLogOutcome<T> =
  | { readonly completed: true; readonly value: T }
  | { readonly completed: false; readonly error: unknown };

/** Whether a root commits or discards its changes when it ends. */
export type CommitLogDisposition = "commit" | "discard";

/** Options for {@link runInCommitLogRoot}. */
export interface CommitLogRootOptions<T>
  extends Omit<CommitLogUnitOptions, "parent"> {
  /**
   * Decides from the outcome whether the root commits or discards, as
   * `pushWhen` decides a legacy root's push. By default it commits when
   * `fn` resolves and discards when it throws. A workflow run passes
   * {@link runOutcomeDisposition}.
   */
  readonly disposition?: (outcome: CommitLogOutcome<T>) => CommitLogDisposition;
  /**
   * Settles a refusal before a root commits (decision 7, swamp-club#3257).
   * When given, a root that commits checkpoints first; if a partition was
   * refused, it runs this with the root ambient, so the caller can save each
   * held run again with the steps that wrote refused data failed
   * ({@link reconcileRefusedRuns}), then releases the held run records,
   * commits, and throws the refusal. Without it, a refusal holds every run
   * record back and surfaces when the root commits. A child never runs it:
   * its root commits.
   */
  readonly onRefused?: (error: PartitionsRefusedError) => Promise<void>;
}

/**
 * What `fn` gets of its root: it stages typed changes and can commit
 * partway through, but never ends the root. `stage` takes the path-only
 * changes a v2 root takes and refuses them (`PathOnlyChangeRefusedError`),
 * so code written against a v2 root fails loudly on v3 rather than losing
 * its change.
 */
export type CommitLogRoot = Pick<
  CommitLogUnitOfWork,
  "stage" | "staged" | "stageOp" | "stageOps" | "stagedOps" | "checkpoint"
>;

/** Commits when `fn` resolved, discards when it threw. */
export function defaultDisposition<T>(
  outcome: CommitLogOutcome<T>,
): CommitLogDisposition {
  return outcome.completed ? "commit" : "discard";
}

/**
 * The terminal statuses a workflow run's unit commits on (decision 5), as
 * `WorkflowRun` records them: decision 5's "completed" is `succeeded`
 * (swamp-club#3257).
 */
export const RUN_COMMIT_STATUSES = [
  "succeeded",
  "failed",
  "suspended",
  "cancelled",
] as const;

/**
 * Decision 5 of "v3 domain model" (`design/enablers/datastores.md`): a
 * workflow run's root commits when the run ends `completed`, `failed`,
 * `suspended` or `cancelled` (a suspended run must be durable to resume; a
 * failed or cancelled run's record is its outcome), and discards on an
 * error. `fn` must therefore resolve with the run's terminal status, not
 * throw, when the run fails or is cancelled: a throw discards the run's
 * record back to what its last checkpoint committed, since a run
 * checkpoints as it saves its record (swamp-club#3587).
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
 * Runs `fn` in a commit-log root over `repoContext.markDirty`, then ends the
 * root as `options.disposition` decides.
 *
 * - The context must have a hook: it is the context's identity. The hook is
 *   marked with `requireUnit`, so a write outside every unit bound to it is
 *   refused from then on (decision 3).
 * - `fn` runs with the root ambient, so the context's repositories stage
 *   into it. Inside an open commit-log unit for the same hook the root is
 *   that unit's child: its changes roll up, and the outer root commits.
 * - When `fn` threw, its error is rethrown; an error ending the root then is
 *   logged at warn. When `fn` resolved, an error ending the root is thrown.
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
  const { disposition = defaultDisposition, onRefused, ...unitOptions } =
    options;
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
  let value: T;
  try {
    value = await runInUnitOfWork(root, () => fn(view));
  } catch (error) {
    try {
      if (disposition({ completed: false, error }) === "commit") {
        await root.commit();
      } else {
        await root.abandon();
      }
    } catch (endError) {
      // An end that could not record the failure says so instead of it.
      rethrowUnrecordedEnd(endError, error);
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
    : await settleRefusals(root, onRefused);
  await root.commit();
  if (refused !== undefined) {
    refusalsThrownAfterCommit.add(refused);
    throw refused;
  }
  return value;
}

/** The settled refusals {@link runInCommitLogRoot} threw after it committed. */
const refusalsThrownAfterCommit = new WeakSet<PartitionsRefusedError>();

/**
 * Whether `error` is a settled refusal {@link runInCommitLogRoot} threw
 * after its root committed (swamp-club#3587). Any other error, a refusal the
 * root's own commit threw included, may have left the root uncommitted.
 */
export function wasThrownAfterCommit(error: unknown): boolean {
  return error instanceof PartitionsRefusedError &&
    refusalsThrownAfterCommit.has(error);
}

/**
 * Checkpoints `root`; on a refusal, runs `onRefused` with the root ambient
 * and releases the held run records. Returns the refusal, which the caller
 * throws once the root has committed. Another checkpoint error is retried a
 * few times, then left to the commit, which retries what is pending and
 * surfaces it.
 */
async function settleRefusals(
  root: CommitLogUnitOfWork,
  onRefused: (error: PartitionsRefusedError) => Promise<void>,
): Promise<PartitionsRefusedError | undefined> {
  // A transient failure leaves its partition pending; checkpoint again, so a
  // refusal behind it is met here, where it can be settled, rather than at
  // the commit, which would lose the held run records.
  for (let attempt = 1;; attempt++) {
    try {
      await root.checkpoint();
      return undefined;
    } catch (error) {
      if (error instanceof PartitionsRefusedError) {
        return await settle(root, onRefused, error);
      }
      if (attempt === SETTLE_CHECKPOINT_ATTEMPTS) return undefined;
    }
  }
}

/** How often a root checkpoints to settle refusals before it commits. */
const SETTLE_CHECKPOINT_ATTEMPTS = 3;

/** Runs `onRefused` for `error` in `root` and releases its held runs. */
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

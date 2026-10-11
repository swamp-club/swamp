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
import type {
  CommitLogUnitOfWork,
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
}

/**
 * What `fn` gets of its root: it stages typed changes and can commit
 * partway through, but never ends the root.
 */
export type CommitLogRoot = Pick<
  CommitLogUnitOfWork,
  "stageOp" | "stageOps" | "stagedOps" | "checkpoint"
>;

/** Commits when `fn` resolved, discards when it threw. */
export function defaultDisposition<T>(
  outcome: CommitLogOutcome<T>,
): CommitLogDisposition {
  return outcome.completed ? "commit" : "discard";
}

/** The terminal statuses a workflow run's unit commits on (decision 5). */
export const RUN_COMMIT_STATUSES = [
  "completed",
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
 * record.
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
  const { disposition = defaultDisposition, ...unitOptions } = options;
  const root = createCommitLogUnitOfWork(markDirty, {
    ...unitOptions,
    parent: commitLogParentFor(markDirty, currentUnitOfWork()),
  });
  const view: CommitLogRoot = {
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
      logger
        .warn`Ending a commit-log unit of work after a failed operation also failed: ${endError}`;
    }
    throw error;
  }
  if (disposition({ completed: true, value }) === "commit") {
    await root.commit();
  } else {
    await root.abandon();
  }
  return value;
}

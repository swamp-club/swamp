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
 * The ports of the commit-log unit of work: decision 1 of "v3 domain
 * model" in `design/enablers/datastores.md` (swamp-club#3233, implemented
 * by swamp-club#3240 in
 * `src/infrastructure/datastore_v3/commit_log_unit_of_work.ts`). How a unit
 * claims a repository context is the generic `UnitOfWorkBinding`
 * (`src/domain/datastore/unit_of_work.ts`).
 *
 * @module
 */

import {
  type UnitOfWork,
  UnrecordedEndError,
} from "../datastore/unit_of_work.ts";
import { UserError } from "../errors.ts";
import type { FileAccess } from "./file_access.ts";
import type { Intent } from "./intent.ts";
import type { Op, PutExpect } from "./op.ts";
import { CommitRejectedError, type CommitRejection } from "./partition.ts";
import type { PartitionKey } from "./partition_key.ts";
import type { RecordKey } from "./record_key.ts";

/**
 * The content of a put the unit stores when it commits.
 *
 * - **Bytes**, for small records.
 * - **A function returning a fresh stream** of the content each time it is
 *   called, for content that should not be held in memory between staging
 *   and commit: a repository passes "open the file I just wrote". A retry
 *   after a failed upload calls it again, so a stream is never read twice.
 *
 * A source is read when the put commits, not when it is staged, and at
 * most once: a retry of a failed commit reuses the content stored the first
 * time. The one exception is repair after a chunk GC race (swamp-club#3249):
 * when a landed commit's chunk is missing, the source is read again, and it
 * must give the same content or the commit fails loudly. The unit drops a stream put before reading it when a later put or
 * tombstone of the same key, carrying no `expect`, supersedes it in the same
 * unit (swamp-club#3250), so a repository may rewrite or remove the file
 * after staging it. Until then the file must stay readable and unchanged.
 */
export type ContentSource =
  | Uint8Array
  | (() => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>);

/**
 * A put whose content the unit stores at commit: inline when it is at most
 * `MAX_INLINE_BYTES` (`op.ts`), as chunks otherwise. A put whose content
 * needs a chunk cannot be built before the chunk is stored, because `putOp`
 * takes the chunk's `BlobRef`; staging the content instead keeps chunk
 * uploads at commit, so an abandoned unit uploads nothing.
 */
export interface PendingPut {
  readonly intent: Intent;
  readonly key: RecordKey;
  readonly expect?: PutExpect;
  readonly content: ContentSource;
  /** The materialised file's access (swamp-club#3693); none when plain. */
  readonly access?: FileAccess;
}

/**
 * One typed change a repository stages into a commit-log unit, with the
 * partition its intent belongs to: an op built by the op factories, or a
 * put whose content the unit stores at commit.
 *
 * Decision 1: repositories that run on a v3 datastore stage typed changes
 * through this sibling port, beside the path-only `StagedChange` they stage
 * today. A path alone cannot become a commit: the commit needs the intent
 * serve authorises on and the content the partition records.
 */
export type TypedChange =
  | { readonly partition: PartitionKey; readonly op: Op }
  | { readonly partition: PartitionKey; readonly put: PendingPut };

/**
 * A unit of work that commits to the v3 commit log.
 *
 * - `stageOp` records a typed change; `stage` (path-only) is refused on v3
 *   rather than guessed into an op.
 * - `commit` commits each partition touched, data partitions first and a
 *   workflow run's record last (decision 7).
 * - `abandon` discards the staged ops (decision 4).
 * - `checkpoint` commits each partition touched so far and keeps the unit
 *   open (decision 6).
 * - A partition's changes past `MAX_COMMIT_OPS` commit as several commits,
 *   split between batches (swamp-club#3250).
 */
export interface CommitLogUnitOfWork extends UnitOfWork {
  stageOp(change: TypedChange): Promise<void>;
  /**
   * Releases the workflow run records held back since a partition was
   * refused (decision 7, swamp-club#3257). The caller acknowledges once it
   * has saved each affected run again so its record names no refused data;
   * the re-save supersedes the held record. Only a root holds them, so a
   * child refuses the call.
   */
  acknowledgeRefusals(): void;
  /**
   * Records several typed changes as one batch, all or nothing. A
   * partition's changes split into several commits when they pass
   * `MAX_COMMIT_OPS`, but only between batches, so one batch always lands
   * in one commit; a batch holding more than that for one partition is
   * refused.
   */
  stageOps(changes: readonly TypedChange[]): Promise<void>;
  checkpoint(): Promise<void>;
  /** The typed changes staged so far, in staging order. */
  stagedOps(): readonly TypedChange[];
}

/** One partition whose commit a unit's flush refused. */
export interface PartitionRefusal {
  readonly partition: PartitionKey;
  readonly reason: CommitRejection;
  readonly message: string;
  /**
   * The data versions the refused changes recorded (their `data-version`
   * ops), by data id: what a workflow run's steps name as data artifacts,
   * so a run can mark the steps that wrote them failed.
   */
  readonly versions: readonly {
    readonly dataId: string;
    readonly version: number;
  }[];
}

/**
 * A unit's flush met one or more refused partitions (swamp-club#3257).
 *
 * - `refusals` are every non-run partition refused since the unit last
 *   acknowledged, earlier flushes' included, and the run partitions this
 *   flush refused: all that `acknowledgeRefusals` would clear.
 * - `heldRuns` are the workflow run partitions not committed because a
 *   refusal is unacknowledged: a run record must never name data its
 *   partition refused (decision 7), and a run's record is rewritten whole on
 *   each save, so it is held for the unit's lifetime, not one flush.
 *
 * It is a `CommitRejectedError` with the first refusal's reason, and its
 * message carries each refusal's message, so a caller that handles one
 * refusal handles it unchanged. `cause` is set when another failure in the
 * same flush (a transient append error) stopped it after the refusal.
 */
export class PartitionsRefusedError extends CommitRejectedError {
  constructor(
    readonly refusals: readonly PartitionRefusal[],
    readonly heldRuns: readonly PartitionKey[],
    cause?: unknown,
  ) {
    if (refusals.length === 0) {
      throw new Error("PartitionsRefusedError needs at least one refusal");
    }
    const held = heldRuns.length === 0 ? "" : `; ${heldRuns.length} workflow ` +
      `run record(s) were held back, since they may name data a refused ` +
      `partition did not record (${heldRuns.join(", ")})`;
    super(
      refusals[0].reason,
      refusals.map((refusal) => refusal.message).join("; ") + held,
    );
    this.name = "PartitionsRefusedError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** Error code for {@link MayLandLaterError}. */
export const COMMIT_MAY_LAND_CODE = "datastore_v3_commit_may_land";

/**
 * A v3 unit's commit failed, or was given up, and swamp could not record that
 * it must not land (swamp-club#3586): the commit outbox, which would let the
 * next writer land it, could be neither cleared nor marked, and nothing could
 * read whether it had landed. The change may already be in the datastore, or
 * be landed by the next swamp command that writes it, so running the command
 * again blindly could make it twice. `cause` is the failure the unit met, if
 * any; `reason` why it could not be recorded.
 */
export class MayLandLaterError extends UnrecordedEndError {
  constructor(cause: unknown, readonly reason: unknown) {
    const failed = cause === undefined ? "" : `${messageOf(cause)}. `;
    super(
      `${failed}Swamp could not record that this change must not be ` +
        `committed (${messageOf(reason)}), so it may already be in the v3 ` +
        `datastore, or be committed by the next swamp command that writes ` +
        `it. Check the datastore before running this command again.`,
      COMMIT_MAY_LAND_CODE,
    );
    this.name = "MayLandLaterError";
    if (cause !== undefined) this.cause = cause;
  }

  during(failure: unknown): MayLandLaterError {
    return new MayLandLaterError(failure, this.reason);
  }
}

/** Error code for {@link CommitUnreachableError}. */
export const COMMIT_UNREACHABLE_CODE = "datastore_v3_commit_unreachable";

/**
 * A v3 unit's commit could not reach the datastore's storage to store the
 * content it names, and the unit gave the commit up, so nothing of it was
 * committed and nothing can land later (swamp-club#3759). Running the command
 * again once the datastore is reachable is safe for the datastore. `cause` is
 * the storage failure. A run's steps ran before its commit, so
 * {@link afterStepsRan} says what they did outside swamp may have happened.
 */
export class CommitUnreachableError extends UserError {
  constructor(cause: unknown, options: { readonly stepsRan?: boolean } = {}) {
    const recheck = options.stepsRan === true
      ? "Its steps had already run, so check anything they changed outside " +
        "swamp before running it again once the datastore is reachable."
      : "Run it again once the datastore is reachable.";
    super(
      `Swamp could not reach the datastore's storage (${messageOf(cause)}), ` +
        `so nothing this command changed was committed. ${recheck}`,
      COMMIT_UNREACHABLE_CODE,
    );
    this.name = "CommitUnreachableError";
    this.cause = cause;
  }

  /** This error, for a model method run or workflow run whose steps ran. */
  afterStepsRan(): CommitUnreachableError {
    return new CommitUnreachableError(this.cause, { stepsRan: true });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

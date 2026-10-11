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

import type { UnitOfWork } from "../datastore/unit_of_work.ts";
import type { Intent } from "./intent.ts";
import type { Op, PutExpect } from "./op.ts";
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

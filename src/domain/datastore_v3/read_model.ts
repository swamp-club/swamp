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
 * The v3 read model port (swamp-club#3239): the local files, the v3 catalog
 * and the live-record index, brought up to date with the commit store.
 *
 * The read model is a cache of the commits: it can be rebuilt from them at
 * any time, and applying a commit a second time changes nothing. It is
 * per checkout: each repository catches its own local files up from its own
 * cursor. Dormant: nothing in production uses it yet.
 *
 * @module
 */

import type { BlobRef } from "./blob_ref.ts";
import type { PartitionKey } from "./partition_key.ts";
import type { RecordKey } from "./record_key.ts";

/** What a catch-up applied. */
export interface CatchUpResult {
  /** How many commits it applied. Commits it skipped are not counted. */
  readonly applied: number;
  /** The store-wide cursor after it: the last change it applied or skipped. */
  readonly cursor: number;
}

/** Where a live record's content is: inline in its commit, or in chunks. */
export type LiveRecordContent =
  | { readonly kind: "inline" }
  | { readonly kind: "blob"; readonly blob: BlobRef };

/**
 * One record present in a partition, as the live-record index holds it.
 * Chunk garbage collection computes the chunks in use from these.
 */
export interface LiveRecord {
  readonly key: RecordKey;
  /** The SHA-256 of the record's bytes. */
  readonly sha256: string;
  readonly content: LiveRecordContent;
}

/**
 * A commit could not be applied: a chunk it names is missing or damaged, a
 * put's blob still lives in a pre-v3 layout, or a write failed. The cursor
 * stays before the commit, so the next catch-up tries it again. A key the
 * read model must not write, and a file and a directory claiming one path,
 * are permanent instead: such a put is logged and skipped, and stays
 * indexed.
 */
export class ReadModelApplyError extends Error {
  constructor(
    readonly namespace: string,
    readonly partition: string,
    readonly seq: number,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(
      `Cannot apply commit ${seq} of partition ${partition}${
        namespace === "" ? "" : ` in namespace ${namespace}`
      } to the read model: ${detail}`,
      options,
    );
    this.name = "ReadModelApplyError";
  }
}

/**
 * The index is not complete yet: the read model has not caught up with the
 * whole change feed since it was built or last reset, so it may be missing
 * records. Run {@link ReadModel.catchUp} until it returns.
 */
export class ReadModelIncompleteError extends Error {
  constructor() {
    super(
      "The read model has not caught up with every commit since it was built or reset; catch up before reading its index",
    );
    this.name = "ReadModelIncompleteError";
  }
}

/**
 * The read side of the commit log for one checkout.
 *
 * The catch-ups take an `AbortSignal`. An abort stops between commits, or
 * during a chunk read, and leaves the cursor at the last commit fully
 * applied. Waiting for another process to release the read model's lock is
 * not abortable: the OS lock has no abort hook.
 */
export interface ReadModel {
  /**
   * Applies every commit that landed after the stored cursor, in landing
   * order, advancing the cursor after each one's effects are durable. When
   * it reaches the end of the change feed, the index is complete.
   */
  catchUp(signal: AbortSignal): Promise<CatchUpResult>;

  /**
   * Applies one partition's commits after the last one this read model
   * applied, before a read of that partition. The store-wide cursor does not
   * move; a later {@link catchUp} skips the commits applied here.
   */
  catchUpPartition(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<CatchUpResult>;

  /**
   * The records present in a partition, by key. Rejects with
   * {@link ReadModelIncompleteError} until a catch-up has reached the end of
   * the change feed since the read model was built or reset: until then a
   * partition catch-up or a replay cut short may have filled only part of
   * the index.
   */
  liveRecords(
    namespace: string,
    partition: PartitionKey,
  ): Promise<readonly LiveRecord[]>;

  /**
   * The SHA-256 of every chunk a live record's blob names in a namespace,
   * parts expanded: the chunks chunk garbage collection must keep. Rejects
   * with {@link ReadModelIncompleteError} like {@link liveRecords}, so a
   * partial index never reads as the set to keep.
   */
  chunksInUse(namespace: string): Promise<ReadonlySet<string>>;

  /** Waits for a catch-up in progress, then closes. Closing again does nothing. */
  close(): Promise<void>;
}

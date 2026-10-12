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
 * The commit store port (swamp-club#3236): where `commits.db` keeps the
 * commits of every partition, enforcing the partition rules in storage.
 *
 * This is core's own store, not an extension contract. `commits/1`, the
 * contract for backends that are themselves the commit store, is a later
 * phase.
 *
 * @module
 */

import type { LiveDataVersion } from "./catalog_projection.ts";
import type { Commit } from "./commit.ts";
import type { BaseRecord } from "./compaction.ts";
import type {
  CompactionCandidate,
  CompactionRetention,
} from "./compaction_policy.ts";
import type { DataMetadata } from "../data/data_metadata.ts";
import type { FileOwnership } from "./materialisation.ts";
import type { PartitionKey } from "./partition_key.ts";

/** What {@link CommitStore.append} did with a commit it accepted. */
export type CommitStoreAppendResult =
  /** The commit landed as the partition's new last commit. */
  | { readonly kind: "appended"; readonly seq: number }
  /**
   * The partition already held a commit with this txnId, at `seq`. Nothing
   * was written.
   */
  | { readonly kind: "duplicate"; readonly seq: number };

/** A partition's last commit, as the store records it. */
export interface PartitionHead {
  /** The seq of the last commit; 0 for a partition with none. */
  readonly seq: number;
  /** The highest fence any commit or lease op carried, if any. */
  readonly highestFence: number | undefined;
}

/** One entry of the store-wide change feed. */
export interface CommitChange {
  /** The entry's position. Positions only grow and are never reused. */
  readonly cursor: number;
  readonly commit: Commit;
}

/**
 * A stored commit could not be rebuilt: it does not parse, or it breaks a
 * partition rule against the commits before it. The store is damaged (a hand
 * edit or a bad restore); this is never a refusal of the commit being
 * appended.
 */
export class CommitStoreCorruptError extends Error {
  constructor(
    readonly namespace: string,
    readonly partition: string,
    readonly seq: number,
    readonly detail: string,
  ) {
    super(
      `Stored commit ${seq} of partition ${partition}${
        namespace === "" ? "" : ` in namespace ${namespace}`
      } cannot be rebuilt: ${detail}`,
    );
    this.name = "CommitStoreCorruptError";
  }
}

/**
 * The commits asked for were compacted away (swamp-club#3258): a feed read
 * from below the compaction point, or a partition read from at or below its
 * compacted seq. A reader loads the compacted base
 * ({@link CommitStore.readCompactedBase}) and continues after the point.
 */
export class CommitsCompactedError extends Error {
  constructor(
    /** The store's compaction point. */
    readonly point: number,
    detail: string,
  ) {
    super(
      `${detail}: those commits were compacted (compaction point ${point})`,
    );
    this.name = "CommitsCompactedError";
  }
}

/** One entry of the compacted base, as {@link CommitStore.readCompactedBase} pages it. */
export type CompactedBaseEntry =
  /** A partition's last compacted seq. */
  | {
    readonly kind: "partition";
    readonly namespace: string;
    readonly partition: string;
    readonly seq: number;
  }
  /** A record present in a partition. */
  | {
    readonly kind: "record";
    readonly namespace: string;
    readonly partition: string;
    readonly key: string;
    readonly record: BaseRecord;
  }
  /** One live version of a data name. */
  | {
    readonly kind: "version";
    readonly namespace: string;
    readonly partition: string;
    readonly version: LiveDataVersion;
  }
  /** One catalog row of a data name. */
  | {
    readonly kind: "catalog-row";
    readonly namespace: string;
    readonly partition: string;
    readonly metadata: DataMetadata;
  }
  /** A data name's catalog forward. */
  | {
    readonly kind: "forward";
    readonly namespace: string;
    readonly partition: string;
    readonly name: string;
    readonly to: string;
  }
  /** Which put a materialised key shows. */
  | {
    readonly kind: "file";
    readonly namespace: string;
    readonly key: string;
    readonly ownership: FileOwnership;
  };

/** One page of the compacted base. */
export interface CompactedBasePage {
  /**
   * The compaction point the page was read at. A reader that sees it change
   * between pages read parts of two bases and must start again.
   */
  readonly point: number;
  readonly entries: readonly CompactedBaseEntry[];
  /** Pass to the next read; undefined after the last page. */
  readonly next: string | undefined;
}

/** Options for {@link CommitStore.compactHistory}. */
export interface CompactHistoryOptions {
  /** Commits folded per transaction. */
  readonly batchSize?: number;
  /** Stops between batches. */
  readonly signal?: AbortSignal;
  /** When chunks are released; the wall clock by default. */
  readonly clock?: () => Date;
  /**
   * How long a released chunk keeps counting as referenced before
   * compaction forgets the release: at least the longest grace period any
   * chunk sweep uses. `DEFAULT_CHUNK_GRACE_MS` by default.
   */
  readonly releasedRetentionMs?: number;
}

/** What {@link CommitStore.compactHistory} did. */
export interface CompactionReport {
  /** The compaction point after it. */
  readonly point: number;
  /** Commits folded into the base and deleted. */
  readonly compacted: number;
  /** Transactions it committed. */
  readonly batches: number;
  /** Chunks no stored commit or base record names any more. */
  readonly released: number;
}

/**
 * The commits of every partition of one datastore, all namespaces included.
 *
 * Every append applies the commit through `Partition.append`, so the store
 * keeps exactly the aggregate's rules. A refusal is the domain's
 * `CommitRejectedError` and writes nothing.
 *
 * A process holds one writer per store. Two processes writing one store is a
 * bug, which the solo writer lock prevents.
 */
export interface CommitStore {
  /**
   * Appends a commit to its namespace's partition. Refuses with
   * `CommitRejectedError`; a retry of a commit that landed returns
   * `duplicate` with the seq it landed at.
   */
  append(commit: Commit): Promise<CommitStoreAppendResult>;

  /**
   * A partition's commits from `fromSeq` on, in seq order, at most `limit`
   * of them, each with its position in the change feed. A partition's
   * positions grow with its seqs. The read model orders the puts of one
   * record key from different partitions by position (swamp-club#3256).
   * Rejects with {@link CommitsCompactedError} when `fromSeq` is at or below
   * the partition's compacted seq.
   */
  readPartition(
    namespace: string,
    partition: PartitionKey,
    fromSeq: number,
    limit: number,
  ): Promise<readonly CommitChange[]>;

  /** A partition's head; seq 0 with no fence for a partition never written. */
  head(namespace: string, partition: PartitionKey): Promise<PartitionHead>;

  /**
   * The commits that landed after `cursor`, in the order they landed, at most
   * `limit` of them. Pass 0 to read from the start. Rejects with
   * {@link CommitsCompactedError} when `cursor` is below the compaction
   * point.
   */
  changesSince(cursor: number, limit: number): Promise<readonly CommitChange[]>;

  /**
   * The subset of `hashes` that some stored commit of `namespace` names as a
   * chunk (`Commit.chunkRefs`), whether or not a later commit replaced or
   * deleted that content: a checkout catching up from the start reads every
   * one. Chunk garbage collection keeps these.
   *
   * After history compaction (swamp-club#3258) a chunk counts while a
   * stored commit or a compacted base record names it, or while it was
   * released (its last reference compacted away) at or after
   * `releasedSince`. Without `releasedSince` every released chunk counts.
   */
  referencedChunks(
    namespace: string,
    hashes: readonly string[],
    releasedSince?: Date,
  ): Promise<Set<string>>;

  /**
   * The history a compaction may fold under `retention`, the newest commits
   * and recent ones kept (swamp-club#3258).
   */
  compactionStatus(
    retention: CompactionRetention,
  ): Promise<CompactionCandidate>;

  /**
   * Folds every commit with a cursor at or below `through` into the
   * compacted base and deletes it, in batches of one transaction each, and
   * moves the compaction point to the last cursor folded. Runs between
   * appends. A crash leaves each batch whole or absent.
   */
  compactHistory(
    through: number,
    options?: CompactHistoryOptions,
  ): Promise<CompactionReport>;

  /**
   * The compacted base, a page at a time, in a fixed order. Pass the
   * previous page's `next`, undefined to start.
   */
  readCompactedBase(
    after: string | undefined,
    limit: number,
  ): Promise<CompactedBasePage>;

  /**
   * Waits for appends already started, then closes the store. Every other
   * call after it rejects; closing again does nothing.
   */
  close(): Promise<void>;
}

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

import type { Commit } from "./commit.ts";
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
   * of them.
   */
  readPartition(
    namespace: string,
    partition: PartitionKey,
    fromSeq: number,
    limit: number,
  ): Promise<readonly Commit[]>;

  /** A partition's head; seq 0 with no fence for a partition never written. */
  head(namespace: string, partition: PartitionKey): Promise<PartitionHead>;

  /**
   * The commits that landed after `cursor`, in the order they landed, at most
   * `limit` of them. Pass 0 to read from the start.
   */
  changesSince(cursor: number, limit: number): Promise<readonly CommitChange[]>;

  /**
   * Waits for appends already started, then closes the store. Every other
   * call after it rejects; closing again does nothing.
   */
  close(): Promise<void>;
}

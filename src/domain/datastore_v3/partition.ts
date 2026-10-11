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
 * The partition aggregate (swamp-club#3233): the storage of one aggregate
 * instance, and the rules every commit to it must keep.
 *
 * In memory and pure. Persisting partitions is the commit store's job; it
 * replays commits through {@link Partition.append} to enforce the same rules.
 *
 * @module
 */

import { maxOf } from "../array_extrema.ts";
import type { Commit } from "./commit.ts";
import type { PartitionKey } from "./partition_key.ts";
import type { RecordKey } from "./record_key.ts";

/** Why a partition refused a commit. */
export type CommitRejection =
  /** The commit is for another partition. */
  | "partition-mismatch"
  /** The commit's seq is not the partition's seq plus one. */
  | "seq-gap"
  /** The commit's fence, or a lease op's, is below the partition's highest. */
  | "stale-fence"
  /** A put's or tombstone's `expect` does not hold. */
  | "expect-failed"
  /** A data-version op's version is not above its name's high-water mark. */
  | "version-not-increasing";

/** A commit the partition refused. The partition is unchanged. */
export class CommitRejectedError extends Error {
  constructor(readonly reason: CommitRejection, message: string) {
    super(message);
    this.name = "CommitRejectedError";
  }
}

/** What {@link Partition.append} did with a commit it accepted. */
export type AppendResult =
  /** The commit applied and is the partition's new last commit. */
  | { readonly kind: "appended"; readonly seq: number }
  /**
   * The partition already holds a commit with this txnId: a retry of a
   * commit that landed. Nothing changed. Identity is the txnId alone; the
   * payload is not compared.
   */
  | { readonly kind: "duplicate" };

/** One data name's versions. */
interface DataName {
  /** The versions not yet removed. */
  readonly live: Set<number>;
  /** The greatest version ever recorded; it never decreases. */
  highWater: number;
}

/** The SHA-256 of a present record; null marks a removal in a draft. */
type RecordState = string | null;

/**
 * The storage of one aggregate instance. Its rules, kept by
 * {@link Partition.append} for every commit:
 *
 * - `seq` is gapless: a partition accepts only its current seq plus one.
 * - A commit whose txnId the partition holds is a no-op, not a second commit.
 * - Data versions only grow: a name's new version is above every version it
 *   ever had (its high-water mark), and versions are never reused. Each name
 *   has exactly one latest, its greatest live version.
 * - A put's or tombstone's `expect` that does not hold refuses the commit.
 * - A commit carrying a fence below the highest the partition has seen is
 *   refused; so is a lease op carrying one. A commit without a fence (solo
 *   mode) is accepted and leaves the highest fence as it was.
 *
 * A commit applies whole or not at all: a refused commit leaves the
 * partition exactly as it was. `append` is synchronous, so its checks and its
 * changes never interleave with another call.
 */
export class Partition {
  #seq = 0;
  #highestFence: number | undefined;
  #leaseHolder: string | undefined;
  readonly #txnIds = new Set<string>();
  readonly #records = new Map<string, string>();
  readonly #names = new Map<string, DataName>();

  private constructor(readonly key: PartitionKey) {}

  /** A partition with no commits. */
  static empty(key: PartitionKey): Partition {
    return new Partition(key);
  }

  /** The seq of the last commit applied; 0 before any. */
  get seq(): number {
    return this.#seq;
  }

  /** The highest fence any accepted commit or lease op carried. */
  get highestFence(): number | undefined {
    return this.#highestFence;
  }

  /** The holder named by the last lease op applied. */
  get leaseHolder(): string | undefined {
    return this.#leaseHolder;
  }

  /** Whether a commit with this txnId has applied. */
  hasTxn(txnId: string): boolean {
    return this.#txnIds.has(txnId);
  }

  /** The digest of the record at `key`, or undefined when it is absent. */
  record(key: RecordKey): { readonly sha256: string } | undefined {
    const sha256 = this.#records.get(key.toString());
    return sha256 === undefined ? undefined : { sha256 };
  }

  /** The keys of every present record, sorted. */
  recordKeys(): readonly string[] {
    return [...this.#records.keys()].sort();
  }

  /** Every data name that has ever had a version, sorted. */
  dataNames(): readonly string[] {
    return [...this.#names.keys()].sort();
  }

  /** A name's live versions, ascending. */
  versions(name: string): readonly number[] {
    return [...(this.#names.get(name)?.live ?? [])].sort((a, b) => a - b);
  }

  /** A name's latest version: its greatest live one, if any. */
  latest(name: string): number | undefined {
    return maxOf(this.#names.get(name)?.live ?? []);
  }

  /** The greatest version a name ever had; 0 for a name never written. */
  highWater(name: string): number {
    return this.#names.get(name)?.highWater ?? 0;
  }

  /**
   * Applies a commit, or refuses it with a {@link CommitRejectedError} and
   * changes nothing. A commit whose txnId the partition already holds is a
   * duplicate: checked first, so retrying a commit that landed is a no-op
   * even though its seq is now behind.
   */
  append(commit: Commit): AppendResult {
    if (this.#txnIds.has(commit.txnId)) return { kind: "duplicate" };
    if (!commit.partition.equals(this.key)) {
      throw new CommitRejectedError(
        "partition-mismatch",
        `Commit for ${commit.partition} sent to partition ${this.key}`,
      );
    }
    if (commit.seq !== this.#seq + 1) {
      throw new CommitRejectedError(
        "seq-gap",
        `Partition ${this.key} is at seq ${this.#seq}; it accepts only ${
          this.#seq + 1
        }, not ${commit.seq}`,
      );
    }
    let fence = this.#highestFence;
    if (commit.fence !== undefined) {
      fence = this.#raiseFence(fence, commit.fence);
    }

    // Stage every change in overlays over the current state, so a refusal
    // part-way through leaves the partition untouched.
    const records = new Map<string, RecordState>();
    const names = new Map<string, DataName>();
    let leaseHolder = this.#leaseHolder;
    const current = (key: string): string | undefined => {
      const staged = records.get(key);
      if (staged === null) return undefined;
      return staged ?? this.#records.get(key);
    };
    const dataName = (name: string): DataName => {
      let entry = names.get(name);
      if (entry === undefined) {
        const base = this.#names.get(name);
        entry = {
          live: new Set(base?.live ?? []),
          highWater: base?.highWater ?? 0,
        };
        names.set(name, entry);
      }
      return entry;
    };

    for (const op of commit.ops) {
      switch (op.kind) {
        case "put": {
          const key = op.key.toString();
          const existing = current(key);
          if (op.expect === "absent" && existing !== undefined) {
            throw this.#expectFailed(key, "absent");
          }
          if (
            typeof op.expect === "object" && existing !== op.expect.sha256
          ) {
            throw this.#expectFailed(key, `sha256 ${op.expect.sha256}`);
          }
          records.set(key, op.sha256);
          break;
        }
        case "tombstone": {
          const key = op.key.toString();
          if (op.expect === "present" && current(key) === undefined) {
            throw this.#expectFailed(key, "present");
          }
          records.set(key, null);
          const intent = op.intent;
          if (
            (intent.kind === "data.delete" || intent.kind === "data.gc") &&
            intent.version !== undefined
          ) {
            dataName(intent.name).live.delete(intent.version);
          }
          break;
        }
        case "data-version": {
          const { name, version } = op.metadata;
          const entry = dataName(name);
          if (version <= entry.highWater) {
            throw new CommitRejectedError(
              "version-not-increasing",
              `Data ${name} version ${version} is not above its high-water mark ${entry.highWater}`,
            );
          }
          entry.live.add(version);
          entry.highWater = version;
          break;
        }
        case "lease":
          fence = this.#raiseFence(fence, op.fence);
          leaseHolder = op.holder;
          break;
      }
    }

    for (const [key, state] of records) {
      if (state === null) this.#records.delete(key);
      else this.#records.set(key, state);
    }
    for (const [name, entry] of names) this.#names.set(name, entry);
    this.#seq = commit.seq;
    this.#txnIds.add(commit.txnId);
    this.#highestFence = fence;
    this.#leaseHolder = leaseHolder;
    return { kind: "appended", seq: commit.seq };
  }

  #raiseFence(highest: number | undefined, fence: number): number {
    if (highest !== undefined && fence < highest) {
      throw new CommitRejectedError(
        "stale-fence",
        `Fence ${fence} is below partition ${this.key}'s highest fence ${highest}`,
      );
    }
    return fence;
  }

  #expectFailed(key: string, expected: string): CommitRejectedError {
    return new CommitRejectedError(
      "expect-failed",
      `Record ${key} in partition ${this.key} is not ${expected}`,
    );
  }
}

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
 * In memory and pure. Persisting partitions is the commit store's job
 * (swamp-club#3236): it applies every commit through
 * {@link Partition.append} to enforce the same rules, and rebuilds a
 * partition from its latest {@link Partition.snapshot} plus the commits
 * after it.
 *
 * @module
 */

import { maxOf } from "../array_extrema.ts";
import { isSha256Hex } from "./blob_ref.ts";
import type { Commit } from "./commit.ts";
import { requireFence } from "./op.ts";
import type { PartitionKey } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";

/** Why a partition refused a commit. */
export type CommitRejection =
  /** The commit is for another partition. */
  | "partition-mismatch"
  /** The commit's seq is not the partition's seq plus one. */
  | "seq-gap"
  /** The commit's fence, or a lease op's, is below the partition's highest. */
  | "stale-fence"
  /** The commit carries no fence, but the partition has seen one. */
  | "unfenced"
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

/**
 * A partition's state at one seq, as plain data: what the commit store keeps
 * so it can rebuild a partition without replaying every commit. Lists are
 * sorted, so equal states serialize equally.
 *
 * It leaves out the txnIds applied so far. They grow with every commit the
 * partition ever had, while the rest grows only with its live records and
 * names, so {@link Partition.restore} takes a lookup for them instead.
 */
export interface PartitionSnapshot {
  readonly v: 1;
  readonly partition: string;
  readonly seq: number;
  readonly highestFence?: number;
  readonly leaseHolder?: string;
  /** Each present record's key and SHA-256. */
  readonly records: readonly (readonly [string, string])[];
  readonly names: readonly {
    readonly name: string;
    readonly live: readonly number[];
    readonly highWater: number;
  }[];
}

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
 *   refused; so is a lease op carrying one. Once a partition has seen a
 *   fence, a commit without one is refused too, so a writer cannot slip past
 *   fencing by leaving it out. Every v3 writer holds a fence, the solo writer
 *   lock's in solo mode and the leader lease's in team mode
 *   (swamp-club#3234), so only a partition that has never seen one accepts
 *   an unfenced commit.
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
  /** For a restored partition, whether a txnId applied before its snapshot. */
  #priorTxn: (txnId: string) => boolean = () => false;
  readonly #records = new Map<string, string>();
  readonly #names = new Map<string, DataName>();

  private constructor(readonly key: PartitionKey) {}

  /** A partition with no commits. */
  static empty(key: PartitionKey): Partition {
    return new Partition(key);
  }

  /**
   * Rebuilds a partition from {@link Partition.snapshot}'s output. Throws
   * when the value is not a snapshot of `key` or breaks the partition's
   * invariants, so a damaged snapshot is never trusted.
   *
   * `priorTxn` answers whether a txnId applied at or before the snapshot's
   * seq, which the snapshot does not hold. It must be synchronous and exact:
   * a false negative would let a retry of an earlier commit apply twice.
   */
  static restore(
    key: PartitionKey,
    value: unknown,
    priorTxn: (txnId: string) => boolean,
  ): Partition {
    const fail = (detail: string): never => {
      throw new Error(`Invalid snapshot of partition ${key}: ${detail}`);
    };
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail("not an object");
    }
    const json = value as Record<string, unknown>;
    const allowed = [
      "v",
      "partition",
      "seq",
      "highestFence",
      "leaseHolder",
      "records",
      "names",
    ];
    for (const field of Object.keys(json)) {
      if (!allowed.includes(field)) fail(`unknown field '${field}'`);
    }
    if (json.v !== 1) fail(`unsupported version ${String(json.v)}`);
    if (json.partition !== key.toString()) {
      fail(`it is a snapshot of ${String(json.partition)}`);
    }
    const partition = new Partition(key);
    const seq = json.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
      return fail("seq is not a non-negative integer");
    }
    partition.#seq = seq;
    if (json.highestFence !== undefined) {
      try {
        requireFence(json.highestFence);
      } catch (error) {
        fail((error as Error).message);
      }
      partition.#highestFence = json.highestFence as number;
    }
    if (json.leaseHolder !== undefined) {
      if (typeof json.leaseHolder !== "string" || json.leaseHolder === "") {
        fail("leaseHolder is not a non-empty string");
      }
      partition.#leaseHolder = json.leaseHolder as string;
    }
    // A lease op always raises the fence, so a holder implies one.
    if (
      partition.#leaseHolder !== undefined &&
      partition.#highestFence === undefined
    ) {
      fail("it names a lease holder but no fence");
    }
    partition.#priorTxn = priorTxn;
    if (!Array.isArray(json.records)) return fail("records is not an array");
    for (const entry of json.records) {
      if (
        !Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== "string" || !isSha256Hex(entry[1])
      ) {
        return fail("a record is not a [key, sha256] pair");
      }
      let recordKey: string;
      try {
        recordKey = RecordKey.create(entry[0]).toString();
      } catch (error) {
        return fail((error as Error).message);
      }
      if (partition.#records.has(recordKey)) {
        fail(`record ${recordKey} appears twice`);
      }
      partition.#records.set(recordKey, entry[1]);
    }
    if (!Array.isArray(json.names)) return fail("names is not an array");
    for (const entry of json.names) {
      if (typeof entry !== "object" || entry === null) {
        return fail("a data name is not an object");
      }
      const fields = entry as Record<string, unknown>;
      for (const field of Object.keys(fields)) {
        if (!["name", "live", "highWater"].includes(field)) {
          return fail(`a data name has the unknown field '${field}'`);
        }
      }
      const { name, live, highWater } = fields;
      if (typeof name !== "string" || partition.#names.has(name)) {
        return fail("a data name is missing or appears twice");
      }
      if (
        typeof highWater !== "number" || !Number.isSafeInteger(highWater) ||
        highWater < 1
      ) {
        return fail(`data ${name}'s high-water mark is not a positive integer`);
      }
      if (
        !Array.isArray(live) ||
        !live.every((v) =>
          typeof v === "number" && Number.isSafeInteger(v) && v >= 1 &&
          v <= highWater
        ) ||
        new Set(live).size !== live.length
      ) {
        return fail(
          `data ${name}'s live versions are not distinct positive integers up to its high-water mark`,
        );
      }
      partition.#names.set(name, {
        live: new Set(live as number[]),
        highWater,
      });
    }
    return partition;
  }

  /** The partition's whole state, for {@link Partition.restore}. */
  snapshot(): PartitionSnapshot {
    return {
      v: 1,
      partition: this.key.toString(),
      seq: this.#seq,
      ...(this.#highestFence === undefined
        ? {}
        : { highestFence: this.#highestFence }),
      ...(this.#leaseHolder === undefined
        ? {}
        : { leaseHolder: this.#leaseHolder }),
      records: [...this.#records.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      ),
      names: [...this.#names.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, entry]) => ({
          name,
          live: [...entry.live].sort((a, b) => a - b),
          highWater: entry.highWater,
        })),
    };
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
    return this.#txnIds.has(txnId) || this.#priorTxn(txnId);
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
   * changes nothing. A commit for another partition is refused first. Then a
   * commit whose txnId the partition already holds is a duplicate, checked
   * before seq, so retrying a commit that landed is a no-op even though its
   * seq is now behind. Retries go to the same partition, so checking the
   * partition first never turns a retry into a refusal.
   */
  append(commit: Commit): AppendResult {
    if (!commit.partition.equals(this.key)) {
      throw new CommitRejectedError(
        "partition-mismatch",
        `Commit for ${commit.partition} sent to partition ${this.key}`,
      );
    }
    if (this.hasTxn(commit.txnId)) return { kind: "duplicate" };
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
    } else if (fence !== undefined) {
      throw new CommitRejectedError(
        "unfenced",
        `Partition ${this.key} has seen fence ${fence}; a commit without a fence is refused`,
      );
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
            // A name never written has no versions to remove; leave it out
            // rather than list it with no versions.
            if (names.has(intent.name) || this.#names.has(intent.name)) {
              dataName(intent.name).live.delete(intent.version);
            }
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

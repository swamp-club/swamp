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
import { type VersionRange, VersionRanges } from "./version_ranges.ts";

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
  /**
   * A data-version op names a version its name already holds live, and the
   * commit carries no `data.append` put for that version.
   */
  | "version-live"
  /**
   * A data-version op names a version its name recorded and then removed,
   * and the commit carries no `data.append` put for that version
   * (swamp-club#3532): a version number never names different content.
   */
  | "version-reused"
  /**
   * A retry older than the commit outbox's retry bound (swamp-club#3490):
   * refused before it is appended, since the store may no longer know its
   * txnId. Raised by the writer, never by the partition.
   */
  | "retry-expired";

/** A commit the partition refused. The partition is unchanged. */
export class CommitRejectedError extends Error {
  /**
   * The record whose `expect` did not hold, for reason `expect-failed`
   * (swamp-club#3915); undefined for every other reason.
   */
  readonly key?: RecordKey;

  constructor(
    readonly reason: CommitRejection,
    message: string,
    key?: RecordKey,
  ) {
    super(message);
    this.name = "CommitRejectedError";
    if (key !== undefined) this.key = key;
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
    /** The versions recorded and then removed, as ranges; absent when none. */
    readonly removed?: readonly VersionRange[];
  }[];
}

/** One data name's versions. */
interface DataName {
  /** The versions not yet removed. */
  readonly live: Set<number>;
  /** The greatest version ever recorded; it never decreases. */
  highWater: number;
  /** The versions recorded and then removed; never recorded again. */
  removed: VersionRanges;
}

function nameVersion(name: string, version: number): string {
  return `${version}:${name}`;
}

/** The SHA-256 of a present record; null marks a removal in a draft. */
type RecordState = string | null;

/**
 * The storage of one aggregate instance. Its rules, kept by
 * {@link Partition.append} for every commit:
 *
 * - `seq` is gapless: a partition accepts only its current seq plus one.
 * - A commit whose txnId the partition holds is a no-op, not a second commit.
 * - A data version is recorded only when its name does not hold it live, so
 *   two writers can never both claim one live version, and has never held
 *   it, so one version number never names two contents (swamp-club#3532):
 *   a version recorded and then removed is refused as `version-reused`.
 *   Versions may still arrive out of order (swamp-club#3250): a deferred
 *   version promoted after a higher one, or parallel writers finishing out
 *   of order, records a version below the high-water mark that was never
 *   recorded. The one exception re-records a version, live or removed: an
 *   append, whose `data.append` put for that name and version comes earlier
 *   in the commit than the data-version op; each such put lets one op
 *   through, and a removed version it re-records is no longer removed. Each
 *   name has exactly one latest, its greatest live version.
 *
 *   Writers allocate above the high-water mark, so a refusal means a writer
 *   bypassed that: for example orphan reclaim re-staging, under a new
 *   txnId, a promoted version that has since been removed. The refused
 *   partition fails the step that wrote it instead of reusing the number.
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
        if (!["name", "live", "highWater", "removed"].includes(field)) {
          return fail(`a data name has the unknown field '${field}'`);
        }
      }
      const { name, live, highWater, removed } = fields;
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
      let removedVersions = VersionRanges.EMPTY;
      if (removed !== undefined) {
        if (!Array.isArray(removed) || removed.some((r) => !Array.isArray(r))) {
          return fail(`data ${name}'s removed versions are not ranges`);
        }
        try {
          removedVersions = VersionRanges.of(removed as number[][]);
        } catch (error) {
          return fail(`data ${name}: ${(error as Error).message}`);
        }
        if (
          removedVersions.max > highWater ||
          live.some((v) => removedVersions.has(v as number))
        ) {
          return fail(
            `data ${name}'s removed versions pass its high-water mark or include a live version`,
          );
        }
      }
      partition.#names.set(name, {
        live: new Set(live as number[]),
        highWater,
        removed: removedVersions,
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
          ...(entry.removed.isEmpty ? {} : { removed: entry.removed.ranges }),
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

  /**
   * How many txnIds the partition holds in memory: those applied since it
   * was created or restored. The ones before a snapshot are looked up
   * instead. For bounding a long-cached partition (swamp-club#3915).
   */
  get txnIdCount(): number {
    return this.#txnIds.size;
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

  /** Whether a name recorded `version` and then removed it. */
  removed(name: string, version: number): boolean {
    return this.#names.get(name)?.removed.has(version) ?? false;
  }

  /**
   * Keeps versions a truncation dropped from being handed out again
   * (swamp-club#3532): raises the name's high-water mark to them and counts
   * each one not live here as removed. A writer whose commits were truncated
   * away may have shared those versions already. Returns whether anything
   * changed.
   */
  retainDroppedVersions(name: string, versions: readonly number[]): boolean {
    let entry = this.#names.get(name);
    let changed = false;
    for (const version of versions) {
      if (entry === undefined) {
        entry = { live: new Set(), highWater: 0, removed: VersionRanges.EMPTY };
        this.#names.set(name, entry);
      }
      if (version > entry.highWater) {
        entry.highWater = version;
        changed = true;
      }
      if (!entry.live.has(version) && !entry.removed.has(version)) {
        entry.removed = entry.removed.add(version);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Keeps what `later`, a state of this partition past this one, knew of its
   * names' versions: each high-water mark, and each removed version not live
   * here. A truncation below the head of an earlier one uses it, so the
   * versions that one retained are not lost (swamp-club#3532). Returns
   * whether anything changed.
   */
  retainVersionsOf(later: Partition): boolean {
    let changed = false;
    for (const [name, theirs] of later.#names) {
      let entry = this.#names.get(name);
      if (entry === undefined) {
        entry = { live: new Set(), highWater: 0, removed: VersionRanges.EMPTY };
        this.#names.set(name, entry);
      }
      if (theirs.highWater > entry.highWater) {
        entry.highWater = theirs.highWater;
        changed = true;
      }
      let removed = entry.removed.union(theirs.removed);
      for (const version of entry.live) removed = removed.delete(version);
      if (!removed.equals(entry.removed)) {
        entry.removed = removed;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Applies a commit, or refuses it with a {@link CommitRejectedError} and
   * changes nothing. A commit for another partition is refused first. Then a
   * commit whose txnId the partition already holds is a duplicate, checked
   * before seq, so retrying a commit that landed is a no-op even though its
   * seq is now behind. Retries go to the same partition, so checking the
   * partition first never turns a retry into a refusal.
   *
   * `replay` is for commits the store already holds: they were accepted
   * under the rules of their time, and a store written before
   * `version-reused` existed may hold a reused version, so replay does not
   * refuse one. It still tracks removed versions, so the next live commit
   * is checked against the whole history.
   */
  append(commit: Commit, options: { replay?: boolean } = {}): AppendResult {
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
          removed: base?.removed ?? VersionRanges.EMPTY,
        };
        names.set(name, entry);
      }
      return entry;
    };

    // The name and version pairs a `data.append` put earlier in this commit
    // lets one data-version op re-record, each used once.
    const appended = new Set<string>();
    for (const op of commit.ops) {
      switch (op.kind) {
        case "put": {
          if (op.intent.kind === "data.append") {
            appended.add(nameVersion(op.intent.name, op.intent.version));
          }
          const key = op.key.toString();
          const existing = current(key);
          if (op.expect === "absent" && existing !== undefined) {
            throw this.#expectFailed(op.key, "absent");
          }
          if (
            typeof op.expect === "object" && existing !== op.expect.sha256
          ) {
            throw this.#expectFailed(op.key, `sha256 ${op.expect.sha256}`);
          }
          records.set(key, op.sha256);
          break;
        }
        case "tombstone": {
          const key = op.key.toString();
          if (op.expect === "present" && current(key) === undefined) {
            throw this.#expectFailed(op.key, "present");
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
              const entry = dataName(intent.name);
              if (entry.live.delete(intent.version)) {
                entry.removed = entry.removed.add(intent.version);
              }
            }
          }
          break;
        }
        case "data-version": {
          const { name, version } = op.metadata;
          const entry = dataName(name);
          const consume = () => appended.delete(nameVersion(name, version));
          if (entry.live.has(version) && !consume()) {
            throw new CommitRejectedError(
              "version-live",
              `Data ${name} version ${version} is already live; only an append re-records it`,
            );
          }
          if (
            !options.replay && !entry.live.has(version) &&
            entry.removed.has(version) && !consume()
          ) {
            throw new CommitRejectedError(
              "version-reused",
              `Data ${name} version ${version} was removed; it is never recorded again`,
            );
          }
          entry.removed = entry.removed.delete(version);
          entry.live.add(version);
          entry.highWater = Math.max(entry.highWater, version);
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

  #expectFailed(key: RecordKey, expected: string): CommitRejectedError {
    return new CommitRejectedError(
      "expect-failed",
      `Record ${key} in partition ${this.key} is not ${expected}`,
      key,
    );
  }
}

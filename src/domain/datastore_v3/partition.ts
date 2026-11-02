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

import { maxOf } from "../array_extrema.ts";
import { isSha256Hex } from "./blob_ref.ts";
import type { Commit } from "./commit.ts";
import type { DataNameMarks } from "./commit_store.ts";
import { requireFence } from "./op.ts";
import type { PartitionKey } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";
import { type VersionRange, VersionRanges } from "./version_ranges.ts";

export type CommitRejection =
  | "partition-mismatch"
  /**
   * The commit's seq is not the partition's seq plus one; for
   * {@link Partition.appendObserved}, not past the partition's seq.
   */
  | "seq-gap"
  | "stale-fence"
  /**
   * a lease op's fence is below the partition's lease fence: the lease it was
   * taken under has since changed hands
   */
  | "stale-lease"
  /**
   * the commit names a model lease serve does not hold for the caller and this
   * partition, or none while one covers it; raised by serve, never by the
   * partition
   */
  | "lease-lost"
  | "unfenced"
  | "expect-failed"
  /**
   * A data-version op names a version its name already holds live, and the
   * commit carries no `data.append` put for that version.
   */
  | "version-live"
  /**
   * a data-version op names a version its name recorded and then removed, with
   * no data.append put for it in the commit: a version number never names
   * different content
   */
  | "version-reused"
  /**
   * a retry older than the commit outbox's retry bound is refused before
   * appending, since the store may not know its txnId; raised by the writer,
   * never by the partition
   */
  | "retry-expired";

export class CommitRejectedError extends Error {
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

export type AppendResult =
  | { readonly kind: "appended"; readonly seq: number }
  /**
   * The partition already holds a commit with this txnId: a retry of a
   * commit that landed. Nothing changed. Identity is the txnId alone; the
   * payload is not compared.
   */
  | { readonly kind: "duplicate" };

/**
 * leaves out applied txnIds, which grow with every commit the partition ever
 * had; Partition.restore takes a lookup for them instead
 */
export interface PartitionSnapshot {
  readonly v: 1;
  readonly partition: string;
  readonly seq: number;
  readonly highestFence?: number;
  readonly leaseFence?: number;
  readonly leaseHolder?: string;
  readonly records: readonly (readonly [string, string])[];
  readonly names: readonly {
    readonly name: string;
    readonly live: readonly number[];
    readonly highWater: number;
    readonly removed?: readonly VersionRange[];
  }[];
}

interface DataName {
  readonly live: Set<number>;
  highWater: number;
  removed: VersionRanges;
}

function nameVersion(name: string, version: number): string {
  return `${version}:${name}`;
}

type RecordState = string | null;

/**
 * a data version already live or once removed is refused unless a data.append
 * put re-records it, so a number never names two contents; a refusal means a
 * writer bypassed allocating above the high-water mark
 */
export class Partition {
  #seq = 0;
  #highestFence: number | undefined;
  #leaseFence: number | undefined;
  #leaseHolder: string | undefined;
  readonly #txnIds = new Set<string>();
  #priorTxn: (txnId: string) => boolean = () => false;
  readonly #records = new Map<string, string>();
  readonly #names = new Map<string, DataName>();

  private constructor(readonly key: PartitionKey) {}

  static empty(key: PartitionKey): Partition {
    return new Partition(key);
  }

  /**
   * throws on a value that is not a snapshot of key or breaks the invariants;
   * priorTxn must be synchronous and exact, since a false negative would let a
   * retry of an earlier commit apply twice
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
      "leaseFence",
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
    if (json.leaseFence !== undefined) {
      try {
        requireFence(json.leaseFence);
      } catch (error) {
        fail((error as Error).message);
      }
      partition.#leaseFence = json.leaseFence as number;
    }
    if (json.leaseHolder !== undefined) {
      if (typeof json.leaseHolder !== "string" || json.leaseHolder === "") {
        fail("leaseHolder is not a non-empty string");
      }
      partition.#leaseHolder = json.leaseHolder as string;
    }
    // A lease op always sets the lease fence, so a holder implies one.
    if (
      partition.#leaseHolder !== undefined &&
      partition.#leaseFence === undefined
    ) {
      fail("it names a lease holder but no lease fence");
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

  snapshot(): PartitionSnapshot {
    return {
      v: 1,
      partition: this.key.toString(),
      seq: this.#seq,
      ...(this.#highestFence === undefined
        ? {}
        : { highestFence: this.#highestFence }),
      ...(this.#leaseFence === undefined
        ? {}
        : { leaseFence: this.#leaseFence }),
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

  get seq(): number {
    return this.#seq;
  }

  get highestFence(): number | undefined {
    return this.#highestFence;
  }

  get leaseFence(): number | undefined {
    return this.#leaseFence;
  }

  get leaseHolder(): string | undefined {
    return this.#leaseHolder;
  }

  /**
   * txnIds applied since the partition was created or restored; earlier ones
   * are looked up instead; for bounding a long-cached partition
   */
  get txnIdCount(): number {
    return this.#txnIds.size;
  }

  hasTxn(txnId: string): boolean {
    return this.#txnIds.has(txnId) || this.#priorTxn(txnId);
  }

  record(key: RecordKey): { readonly sha256: string } | undefined {
    const sha256 = this.#records.get(key.toString());
    return sha256 === undefined ? undefined : { sha256 };
  }

  recordKeys(): readonly string[] {
    return [...this.#records.keys()].sort();
  }

  dataNames(): readonly string[] {
    return [...this.#names.keys()].sort();
  }

  dataNameMarks(): DataNameMarks[] {
    return [...this.#names.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, entry]) => ({
        name,
        highWater: entry.highWater,
        ...(entry.removed.isEmpty ? {} : { removed: entry.removed.ranges }),
      }));
  }

  versions(name: string): readonly number[] {
    return [...(this.#names.get(name)?.live ?? [])].sort((a, b) => a - b);
  }

  latest(name: string): number | undefined {
    return maxOf(this.#names.get(name)?.live ?? []);
  }

  highWater(name: string): number {
    return this.#names.get(name)?.highWater ?? 0;
  }

  removed(name: string, version: number): boolean {
    return this.#names.get(name)?.removed.has(version) ?? false;
  }

  /**
   * keeps versions a truncation dropped from being handed out again: raises the
   * high-water mark and counts each non-live one as removed, since a truncated
   * writer may have shared them
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
   * keeps each high-water mark and removed version of a later state, so a
   * truncation below an earlier one's head does not lose the versions that one
   * retained
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
   * a duplicate txnId is checked before seq, so retrying a landed commit is a
   * no-op; replay does not refuse a reused version an older store may hold, but
   * still tracks removed versions
   */
  append(commit: Commit, options: { replay?: boolean } = {}): AppendResult {
    return this.#apply(commit, options.replay === true, false);
  }

  /**
   * a follower's log copy can have permanent seq holes since serve omits
   * unreadable commits, so any later seq is accepted; expect, version-live and
   * version-reused are serve's to judge, not the follower's
   */
  appendObserved(
    commit: Commit,
    options: { replay?: boolean } = {},
  ): AppendResult {
    return this.#apply(commit, options.replay === true, true);
  }

  #apply(commit: Commit, replay: boolean, observed: boolean): AppendResult {
    if (!commit.partition.equals(this.key)) {
      throw new CommitRejectedError(
        "partition-mismatch",
        `Commit for ${commit.partition} sent to partition ${this.key}`,
      );
    }
    if (this.hasTxn(commit.txnId)) return { kind: "duplicate" };
    if (observed) {
      if (commit.seq <= this.#seq) {
        throw new CommitRejectedError(
          "seq-gap",
          `Partition ${this.key} is at seq ${this.#seq}; it accepts only a later seq, not ${commit.seq}`,
        );
      }
    } else if (commit.seq !== this.#seq + 1) {
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
    let leaseFence = this.#leaseFence;
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
          if (!observed && op.expect === "absent" && existing !== undefined) {
            throw this.#expectFailed(op.key, "absent");
          }
          if (
            !observed && typeof op.expect === "object" &&
            existing !== op.expect.sha256
          ) {
            throw this.#expectFailed(op.key, `sha256 ${op.expect.sha256}`);
          }
          records.set(key, op.sha256);
          break;
        }
        case "tombstone": {
          const key = op.key.toString();
          if (
            !observed && op.expect === "present" && current(key) === undefined
          ) {
            throw this.#expectFailed(op.key, "present");
          }
          if (
            !observed && typeof op.expect === "object" &&
            current(key) !== op.expect.sha256
          ) {
            throw this.#expectFailed(op.key, `sha256 ${op.expect.sha256}`);
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
          if (!observed && entry.live.has(version) && !consume()) {
            throw new CommitRejectedError(
              "version-live",
              `Data ${name} version ${version} is already live; only an append re-records it`,
            );
          }
          if (
            !observed && !replay && !entry.live.has(version) &&
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
          if (leaseFence !== undefined && op.fence < leaseFence) {
            throw new CommitRejectedError(
              "stale-lease",
              `Lease fence ${op.fence} is below partition ${this.key}'s lease fence ${leaseFence}`,
            );
          }
          leaseFence = op.fence;
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
    this.#leaseFence = leaseFence;
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

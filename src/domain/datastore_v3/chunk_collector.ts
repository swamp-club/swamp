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
 * references come from the commit log, not a read model, as a catching-up
 * checkout replays every commit; only chunks older than now minus grace are
 * candidates, and deleted batches are re-checked
 */

// node:crypto, as the chunk store hashes chunks.
import { createHash } from "node:crypto";
import {
  type ChunkQuarantine,
  type DatastoreStorage,
  isChunkDirectorySync,
  isChunkQuarantine,
  type TempFileSweeper,
} from "../datastore/datastore_storage.ts";
import type { Namespace } from "../data/namespace.ts";
import { storageNamespaceOf } from "./chunk_store.ts";
import type { CommitStore } from "./commit_store.ts";

/**
 * far longer than a unit of work lives between storing its chunks and
 * committing them, and than any clock skew between storage and collector
 */
export const DEFAULT_CHUNK_GRACE_MS = 24 * 60 * 60 * 1000;

export const CHUNK_COLLECTION_BATCH = 256;

/**
 * a candidate is read before it is deleted so it can be put back; past this
 * budget candidates are kept for the next sweep
 */
export const DEFAULT_SWEEP_READ_BYTES = 1024 * 1024 * 1024;

/**
 * bounds putting back chunks separately from the sweep's own signal, which may
 * already have aborted
 */
const RESTORE_TIMEOUT_MS = 5 * 60 * 1000;

const MAX_HELD_BYTES = 64 * 1024 * 1024;

/**
 * deleted, unless verifying found it on a storage that cannot move chunks
 * aside, which keeps it
 */
export interface DamagedChunk {
  readonly sha256: string;
  readonly referenced: boolean;
}

export interface ChunkCollectionReport {
  readonly namespace: string;
  readonly scanned: number;
  readonly referenced: number;
  readonly deleted: number;
  readonly restored: number;
  readonly keptOverBudget: number;
  readonly keptTooNew: number;
  readonly verified: number;
  readonly damaged: readonly DamagedChunk[];
  readonly tempFilesRemoved: number;
}

export interface SweepMonitor {
  begin(): Promise<void>;
  heartbeat(): Promise<void>;
  end(): Promise<void>;
  /**
   * runs a whole batch (reference check, deletes, re-check) where an
   * overlapping writer waits, so a chunk judged unreferenced before its commit
   * was prepared is back or absent and the writer's check stores it
   */
  batch?(run: () => Promise<void>): Promise<void>;
}

export interface ChunkCollectorOptions {
  readonly commitStore: Pick<CommitStore, "referencedChunks">;
  readonly sweep?: SweepMonitor;
  /**
   * Throws once the sweeper may no longer delete (it lost the writer
   * lease): checked before and after each batch of deletes.
   */
  readonly assertMayDelete?: () => void;
  readonly storage: DatastoreStorage;
  readonly tempFiles?: TempFileSweeper;
  readonly graceMs?: number;
  readonly clock?: () => Date;
}

export interface CollectOptions {
  readonly verifyBytes?: number;
  readonly verifyFrom?: string;
  readonly sweepReadBytes?: number;
  readonly signal: AbortSignal;
}

export class ChunkCollector {
  readonly #commitStore: Pick<CommitStore, "referencedChunks">;
  readonly #storage: DatastoreStorage;
  readonly #tempFiles: TempFileSweeper | undefined;
  readonly #sweep: SweepMonitor | undefined;
  readonly #assertMayDelete: () => void;
  readonly #graceMs: number;
  readonly #clock: () => Date;

  constructor(options: ChunkCollectorOptions) {
    const graceMs = options.graceMs ?? DEFAULT_CHUNK_GRACE_MS;
    requireNonNegative(graceMs, "graceMs");
    this.#commitStore = options.commitStore;
    this.#storage = options.storage;
    this.#tempFiles = options.tempFiles;
    this.#sweep = options.sweep;
    this.#assertMayDelete = options.assertMayDelete ?? (() => {});
    this.#graceMs = graceMs;
    this.#clock = options.clock ?? (() => new Date());
  }

  async collect(
    namespace: Namespace,
    options: CollectOptions,
  ): Promise<ChunkCollectionReport> {
    const { signal } = options;
    const verifyBytes = options.verifyBytes ?? 0;
    requireNonNegative(verifyBytes, "verifyBytes");
    const verifyFrom = options.verifyFrom ?? "";
    if (!/^[0-9a-f]{0,64}$/.test(verifyFrom)) {
      throw new Error(
        `verifyFrom must be a lowercase hex prefix: ${verifyFrom}`,
      );
    }
    signal.throwIfAborted();
    if (this.#sweep === undefined) {
      return await this.#collect(namespace, options, verifyBytes);
    }
    await this.#sweep.begin();
    let report: ChunkCollectionReport;
    try {
      report = await this.#collect(namespace, options, verifyBytes);
    } catch (error) {
      // The sweep's own failure is the one reported; a heartbeat left
      // behind goes stale on its own.
      await this.#sweep.end().catch(() => {});
      throw error;
    }
    await this.#sweep.end();
    return report;
  }

  async #collect(
    namespace: Namespace,
    options: CollectOptions,
    verifyBytes: number,
  ): Promise<ChunkCollectionReport> {
    const { signal } = options;

    const ns = storageNamespaceOf(namespace);
    // fixed before any reference is read, so a commit landing during the sweep
    // names a chunk newer than the cutoff
    const cutoff = new Date(this.#clock().getTime() - this.#graceMs);
    // A pass of its own, so reading and hashing chunks never stretches the
    // time between the sweep seeing a chunk's age and deleting it.
    const { verified, damaged } = verifyBytes > 0
      ? await this.#verify(
        namespace,
        ns,
        verifyBytes,
        options.verifyFrom ?? "",
        cutoff,
        signal,
      )
      : { verified: 0, damaged: [] };

    let readBudget = options.sweepReadBytes ?? DEFAULT_SWEEP_READ_BYTES;
    requireNonNegative(readBudget, "sweepReadBytes");
    let scanned = 0;
    let referenced = 0;
    let deleted = 0;
    let restored = 0;
    let keptOverBudget = 0;
    let keptTooNew = 0;
    const damagedInSweep: string[] = [];
    let batch: string[] = [];

    const settle = async (held: { sha256: string; bytes: Uint8Array }[]) => {
      if (held.length === 0) return;
      // Every chunk a delete was started for, so the re-check covers it even
      // when the sweep aborts or a delete throws part-way: a commit may have
      // landed on it since the batch's reference check.
      const started: { sha256: string; bytes: Uint8Array }[] = [];
      this.#assertMayDelete();
      await this.#sweep?.heartbeat();
      try {
        for (const chunk of held) {
          signal.throwIfAborted();
          started.push(chunk);
          await this.#storage.delete(ns, chunk.sha256, signal);
        }
      } finally {
        await this.#restoreReferenced(
          namespace,
          ns,
          started,
          cutoff,
          (restoredNow) => {
            deleted += started.length - restoredNow;
            restored += restoredNow;
          },
        );
      }
    };

    const flush = async () => {
      if (batch.length === 0) return;
      await this.#sweep?.heartbeat();
      if (this.#sweep?.batch !== undefined) {
        await this.#sweep.batch(sweepBatch);
      } else {
        await sweepBatch();
      }
      batch = [];
    };

    const sweepBatch = async () => {
      const names = await this.#commitStore.referencedChunks(
        namespace,
        batch,
        cutoff,
      );
      let held: { sha256: string; bytes: Uint8Array }[] = [];
      let heldBytes = 0;
      for (const sha256 of batch) {
        if (names.has(sha256)) {
          referenced++;
          continue;
        }
        if (readBudget <= 0) {
          keptOverBudget++;
          continue;
        }
        signal.throwIfAborted();
        const bytes = await this.#storage.get(ns, sha256, signal);
        if (bytes === null) continue;
        readBudget -= bytes.length;
        if (sha256Hex(bytes) !== sha256) {
          // damaged: deleted, never put back; moved aside first where the
          // storage can, otherwise deleted at once; only while it may still
          // delete
          this.#assertMayDelete();
          if (isChunkQuarantine(this.#storage)) {
            const outcome = await this.#discardDamaged(
              this.#storage,
              ns,
              sha256,
              signal,
            );
            if (outcome !== "restored") damagedInSweep.push(sha256);
          } else {
            await this.#storage.delete(ns, sha256, signal);
            damagedInSweep.push(sha256);
          }
          continue;
        }
        held.push({ sha256, bytes });
        heldBytes += bytes.length;
        if (heldBytes >= MAX_HELD_BYTES) {
          await settle(held);
          held = [];
          heldBytes = 0;
        }
      }
      await settle(held);
    };

    for await (const chunk of this.#storage.list(ns, signal)) {
      signal.throwIfAborted();
      scanned++;
      if (chunk.lastModified.getTime() >= cutoff.getTime()) {
        keptTooNew++;
        continue;
      }
      batch.push(chunk.sha256);
      if (batch.length >= CHUNK_COLLECTION_BATCH) await flush();
    }
    await flush();

    const sweptDamage = damagedInSweep.length === 0
      ? new Set<string>()
      : await this.#commitStore.referencedChunks(
        namespace,
        damagedInSweep,
        cutoff,
      );
    const damagedAll: DamagedChunk[] = [
      ...damaged,
      ...damagedInSweep.map((sha256) => ({
        sha256,
        referenced: sweptDamage.has(sha256),
      })),
    ];

    const tempFilesRemoved = this.#tempFiles === undefined
      ? 0
      : await this.#tempFiles.removeStaleTempFiles(ns, cutoff, signal);
    return {
      namespace: ns,
      scanned,
      referenced,
      deleted,
      restored,
      keptOverBudget,
      keptTooNew,
      verified,
      damaged: damagedAll,
      tempFilesRemoved,
    };
  }

  async #inBatch(run: () => Promise<void>): Promise<void> {
    if (this.#sweep?.batch !== undefined) await this.#sweep.batch(run);
    else await run();
  }

  /**
   * moves a damaged chunk aside and rehashes it: removes it if still damaged,
   * puts it back if good; one not judged is put back unless a chunk was stored
   * since, so a good one is never lost
   */
  async #discardDamaged(
    storage: ChunkQuarantine,
    ns: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<DiscardOutcome> {
    const aside = await storage.quarantineChunk(ns, sha256, signal);
    if (aside === undefined) return "gone";
    let judged = false;
    let restored = false;
    try {
      const bytes = await aside.read(signal);
      if (bytes === null) {
        judged = true;
        return "gone";
      }
      if (sha256Hex(bytes) === sha256) {
        await aside.putBack(signal);
        judged = true;
        restored = true;
        return "restored";
      }
      await aside.remove(signal);
      judged = true;
      return "removed";
    } finally {
      // The sweep's own signal may have aborted.
      const restoreSignal = AbortSignal.timeout(RESTORE_TIMEOUT_MS);
      if (!judged) {
        await aside.putBack(restoreSignal).then(
          () => restored = true,
          () => {},
        );
      }
      if (restored && isChunkDirectorySync(this.#storage)) {
        const synced = this.#storage.syncChunkDirectories(
          ns,
          [sha256],
          restoreSignal,
        );
        // A failure already on its way out is the one reported.
        if (judged) await synced;
        else await synced.catch(() => {});
      }
    }
  }

  /** runs whether or not the sweep was aborted, so it uses a signal of its own */
  async #restoreReferenced(
    namespace: Namespace,
    ns: string,
    deleted: readonly { sha256: string; bytes: Uint8Array }[],
    cutoff: Date,
    count: (restored: number) => void,
  ): Promise<void> {
    if (deleted.length === 0) return;
    const signal = AbortSignal.timeout(RESTORE_TIMEOUT_MS);
    // A sweeper that lost the lease mid-batch puts every chunk back: the new
    // writer's commits, and its outbox, are not in this reference set.
    let leaseLost: unknown;
    try {
      this.#assertMayDelete();
    } catch (error) {
      leaseLost = error;
    }
    const names = leaseLost !== undefined
      ? new Set(deleted.map((chunk) => chunk.sha256))
      : await this.#commitStore.referencedChunks(
        namespace,
        deleted.map((chunk) => chunk.sha256),
        cutoff,
      );
    let restored = 0;
    try {
      for (const { sha256, bytes } of deleted) {
        if (!names.has(sha256)) continue;
        await this.#storage.put(ns, sha256, bytes, signal);
        restored++;
      }
    } finally {
      count(restored);
    }
    if (leaseLost !== undefined) throw leaseLost;
  }

  async #verify(
    namespace: Namespace,
    ns: string,
    budget: number,
    from: string,
    cutoff: Date,
    signal: AbortSignal,
  ): Promise<{ verified: number; damaged: DamagedChunk[] }> {
    let verified = 0;
    const rotten: string[] = [];
    const passes: ((sha256: string) => boolean)[] = from === ""
      ? [() => true]
      : [(sha256) => sha256 >= from, (sha256) => sha256 < from];
    for (const admits of passes) {
      if (budget <= 0) break;
      for await (const chunk of this.#storage.list(ns, signal)) {
        if (budget <= 0) break;
        signal.throwIfAborted();
        if (!admits(chunk.sha256)) continue;
        const bytes = await this.#storage.get(ns, chunk.sha256, signal);
        if (bytes === null) continue;
        budget -= bytes.length;
        verified++;
        if (verified % CHUNK_COLLECTION_BATCH === 0) {
          await this.#sweep?.heartbeat();
        }
        if (sha256Hex(bytes) === chunk.sha256) continue;
        // without a way to move it aside, a chunk stored again since the read
        // could be deleted while good, so it is only reported
        if (!isChunkQuarantine(this.#storage)) {
          rotten.push(chunk.sha256);
          continue;
        }
        const storage = this.#storage;
        let outcome: DiscardOutcome | undefined;
        this.#assertMayDelete();
        // Inside the sweep's batch, where an overlapping writer waits.
        await this.#inBatch(async () => {
          outcome = await this.#discardDamaged(
            storage,
            ns,
            chunk.sha256,
            signal,
          );
        });
        if (outcome !== "restored") rotten.push(chunk.sha256);
      }
    }
    const names = rotten.length === 0
      ? new Set<string>()
      : await this.#commitStore.referencedChunks(namespace, rotten, cutoff);
    return {
      verified,
      damaged: rotten.map((sha256) => ({
        sha256,
        referenced: names.has(sha256),
      })),
    };
  }
}

type DiscardOutcome = "removed" | "restored" | "gone";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer: ${value}`);
  }
}

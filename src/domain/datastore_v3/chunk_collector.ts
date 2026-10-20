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
 * Chunk garbage collection (swamp-club#3249): reclaims stored chunks that no
 * commit names, finds damaged ones and clears a filesystem storage's stale
 * temp files. Run by `swamp datastore gc` and serve's maintenance sweep on a
 * v3 datastore; while it replicates, only once no lineage but the copy's
 * current one can be restored (swamp-club#3491).
 *
 * - **The reference set is the commit log**, not a read model. A checkout
 *   catching up from cursor 0 replays every commit and reads every chunk
 *   each put names, including content a later commit overwrote or deleted,
 *   so a chunk is kept for as long as any stored commit names it
 *   (`CommitStore.referencedChunks`). A read model's `chunksInUse` is one
 *   checkout's present records at its own cursor, and would miss them.
 *   After history compaction (swamp-club#3258) the compacted base's
 *   records count too, and a chunk whose last reference was compacted away
 *   still counts while it was released after the cutoff: a checkout may
 *   still be applying a page of commits it read before the compaction.
 * - **The grace period.** A chunk is stored, or refreshed, before the
 *   commit that names it lands, so a chunk no commit names yet may be one a
 *   unit of work is about to commit. Only a chunk whose `lastModified` is
 *   older than `now - grace` is a candidate. `now` is fixed before any
 *   reference is read, so a commit that lands during the sweep names a
 *   chunk stored or refreshed after `now - grace`: never a candidate.
 * - **Closing the race with a writer.** A writer refreshes a chunk it
 *   finds present and commits later, so a sweep can see a chunk unreferenced
 *   and old, and a commit can land on it before it is deleted. Each batch's
 *   unreferenced candidates are read (and hashed) first, then deleted, then
 *   their references are checked again: a chunk a commit landed on
 *   meanwhile is put back from the bytes read. A commit landing after that
 *   re-check landed after the delete, and the writer checks its chunks
 *   after its commit lands and stores any missing ones again
 *   (`commit_log_unit_of_work.ts`). Either way no commit is left naming a
 *   missing chunk. Reads are bounded by a byte budget; a candidate past it
 *   is kept for the next sweep, never deleted unread. See "v3 chunk garbage
 *   collection" in `design/enablers/datastores.md`.
 * - **A writer that dies after its commit lands** (swamp-club#3490) never
 *   runs its check. On a v3 datastore the reference set also holds the
 *   commit outbox's entries, which a writer prepares before it appends, and
 *   the sweep marks itself in progress ({@link SweepMonitor}) with a
 *   heartbeat each batch. A writer that sees a sweep may have overlapped
 *   checks its chunks before appending; otherwise the sweep's re-check sees
 *   its entry. The writer lease is checked before and after each batch's
 *   deletes, and a batch deleted by a sweep that lost the lease is put back.
 * - **Damaged chunks** are deleted whatever their age, so the next write of
 *   that content finds it absent and stores it again (writes trust `has`).
 *   A damaged chunk a commit names already fails every read; the report
 *   says so. A chunk verifying finds damaged is moved aside first
 *   ({@link ChunkQuarantine}, swamp-club#3617) and hashed again there: a
 *   chunk stored again meanwhile (a checkout putting back the content it
 *   holds) is good now and put back, never deleted. On a storage that
 *   cannot move chunks aside, verifying only reports damage. Verifying
 *   starts at a shard prefix (`verifyFrom`), so sweeps with a small budget
 *   and different prefixes cover the whole namespace over time.
 *
 * @module
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
 * How long an unreferenced chunk is kept after it was last stored or
 * refreshed: far longer than a unit of work lives between storing its
 * chunks and committing them, and than any clock skew between the storage
 * and the collector.
 */
export const DEFAULT_CHUNK_GRACE_MS = 24 * 60 * 60 * 1000;

/** Candidates checked against the commit log, then deleted, at a time. */
export const CHUNK_COLLECTION_BATCH = 256;

/**
 * How many bytes of deletion candidates one sweep reads by default. A
 * candidate is read before it is deleted, so it can be put back; past this
 * budget candidates are kept for the next sweep.
 */
export const DEFAULT_SWEEP_READ_BYTES = 1024 * 1024 * 1024;

/**
 * How long putting back chunks a commit landed on may take, apart from the
 * sweep's own signal, which may already have aborted.
 */
const RESTORE_TIMEOUT_MS = 5 * 60 * 1000;

/** The most candidate bytes held at once before they are deleted. */
const MAX_HELD_BYTES = 64 * 1024 * 1024;

/**
 * A chunk whose bytes do not match its SHA-256. It has been deleted, unless
 * verifying found it on a storage that cannot move chunks aside, which
 * keeps it.
 */
export interface DamagedChunk {
  readonly sha256: string;
  /** True when a commit names it, so its reads were already failing. */
  readonly referenced: boolean;
}

/** What one sweep of a storage namespace found and did. */
export interface ChunkCollectionReport {
  /** The storage namespace swept. */
  readonly namespace: string;
  /** Chunks the listing yielded. */
  readonly scanned: number;
  /** Chunks past the grace period kept because a commit names them. */
  readonly referenced: number;
  /** Unreferenced chunks past the grace period, deleted. */
  readonly deleted: number;
  /**
   * Chunks deleted and then put back, because a commit naming them landed
   * during the sweep.
   */
  readonly restored: number;
  /** Candidates kept unread because the sweep's read budget was spent. */
  readonly keptOverBudget: number;
  /** Chunks stored or refreshed within the grace period, kept unchecked. */
  readonly keptTooNew: number;
  /** Chunks whose bytes were read and checked. */
  readonly verified: number;
  /** Damaged chunks found (see {@link DamagedChunk}). */
  readonly damaged: readonly DamagedChunk[];
  /** Stale temp files removed. */
  readonly tempFilesRemoved: number;
}

/**
 * Marks a sweep in progress where writers look (swamp-club#3490): `begin`
 * before the listing, `heartbeat` each batch, `end` when it finishes or
 * fails.
 */
export interface SweepMonitor {
  begin(): Promise<void>;
  heartbeat(): Promise<void>;
  end(): Promise<void>;
  /**
   * Runs one batch, from its reference check through its deletes and the
   * re-check after them, where a writer that may overlap it waits for it
   * (swamp-club#3586): a chunk the batch judged unreferenced before the
   * writer prepared its commit is either back or absent by then, and the
   * writer's own check stores it again before its commit lands.
   */
  batch?(run: () => Promise<void>): Promise<void>;
}

/** What a {@link ChunkCollector} works over. */
export interface ChunkCollectorOptions {
  readonly commitStore: Pick<CommitStore, "referencedChunks">;
  /** Marks the sweep in progress, when writers prepare commits. */
  readonly sweep?: SweepMonitor;
  /**
   * Throws once the sweeper may no longer delete (it lost the writer
   * lease): checked before and after each batch of deletes.
   */
  readonly assertMayDelete?: () => void;
  readonly storage: DatastoreStorage;
  /** Clears the storage's stale temp files, when it has any. */
  readonly tempFiles?: TempFileSweeper;
  /** {@link DEFAULT_CHUNK_GRACE_MS} unless given; tests pass less. */
  readonly graceMs?: number;
  readonly clock?: () => Date;
}

/** What one {@link ChunkCollector.collect} does. */
export interface CollectOptions {
  /**
   * How many bytes of chunks to read and verify, in listing order; 0 (the
   * default) verifies none. A chunk is read whole, so the last one verified
   * may go past the budget.
   */
  readonly verifyBytes?: number;
  /**
   * Where verifying starts: a lowercase hex prefix. Chunks whose hash sorts
   * at or after it are verified first, then the rest, each from a listing
   * of its own; "" (the default) verifies in listing order.
   */
  readonly verifyFrom?: string;
  /**
   * How many bytes of deletion candidates to read before deleting them;
   * {@link DEFAULT_SWEEP_READ_BYTES} unless given. Candidates past it are
   * kept for the next sweep.
   */
  readonly sweepReadBytes?: number;
  readonly signal: AbortSignal;
}

/** Sweeps one namespace's chunks. A domain service; holds no state. */
export class ChunkCollector {
  readonly #commitStore: Pick<CommitStore, "referencedChunks">;
  readonly #storage: DatastoreStorage;
  readonly #tempFiles: TempFileSweeper | undefined;
  readonly #sweep: SweepMonitor | undefined;
  readonly #assertMayDelete: () => void;
  readonly #graceMs: number;
  readonly #clock: () => Date;

  /** Throws when `graceMs` is not a non-negative safe integer. */
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

  /**
   * Sweeps `namespace`'s chunks: verifies up to `verifyBytes` of them and
   * deletes any damaged, then deletes those no commit names that are past
   * the grace period, then removes stale temp files. Rejects when `signal`
   * aborts; what was deleted by then stays deleted.
   */
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
    // Fixed before any reference is read: see the module doc.
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

    /**
     * Deletes candidates already read, re-checks their references, and puts
     * back the ones a commit landed on meanwhile.
     */
    const settle = async (held: { sha256: string; bytes: Uint8Array }[]) => {
      if (held.length === 0) return;
      // Every chunk a delete was started for, so the re-check covers it even
      // when the sweep aborts or a delete throws part-way: a commit may have
      // landed on it since the batch's reference check.
      const started: { sha256: string; bytes: Uint8Array }[] = [];
      this.#assertMayDelete();
      // Before every batch of deletes, however long the reads before it took.
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
        // Null: deleted since the listing, so nothing is left to sweep.
        if (bytes === null) continue;
        readBudget -= bytes.length;
        if (sha256Hex(bytes) !== sha256) {
          // Damaged: deleted, never put back. Moved aside first where the
          // storage can, as when verifying; otherwise deleted at once, as an
          // unreferenced candidate a commit lands on meanwhile is stored
          // again by its writer's check. Only while it may still delete.
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

  /** Runs `run` inside the sweep's batch, when it has one. */
  async #inBatch(run: () => Promise<void>): Promise<void> {
    if (this.#sweep?.batch !== undefined) await this.#sweep.batch(run);
    else await run();
  }

  /**
   * Moves a chunk found damaged aside and hashes it again there: removes it
   * when still damaged, puts it back when good (stored again since it was
   * read). A chunk gone meanwhile (deleted, or a moved-aside file another
   * process's temp-file sweep removed) is done. A chunk moved aside but not
   * judged, because reading it failed or the sweep aborted, is put back so
   * a good one is never lost, though never over a chunk stored since it was
   * moved aside; whatever is put back has its directory synced.
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

  /**
   * Re-checks the references of chunks just deleted and puts back the ones
   * a commit landed on meanwhile. Runs whether or not the sweep was aborted,
   * so it uses a signal of its own; `count` gets how many were put back.
   */
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

  /**
   * Reads and hashes chunks until `budget` bytes are spent: those whose
   * hash sorts at or after `from` first, then the rest, each from a listing
   * of its own so nothing is held but the chunk being read. Each damaged
   * one is discarded whatever its age (see the module doc). A chunk is read
   * whole, so the last one may go past the budget.
   */
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
        // Null: deleted since the listing, so there is nothing to check.
        if (bytes === null) continue;
        budget -= bytes.length;
        verified++;
        if (verified % CHUNK_COLLECTION_BATCH === 0) {
          await this.#sweep?.heartbeat();
        }
        if (sha256Hex(bytes) === chunk.sha256) continue;
        // Without a way to move it aside, a chunk stored again since the
        // read could be deleted good: only reported (swamp-club#3617).
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

/**
 * What {@link ChunkCollector} did with a damaged chunk it moved aside:
 * removed it, put it back because it hashed good there (stored again since
 * it was read), or found it gone.
 */
type DiscardOutcome = "removed" | "restored" | "gone";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer: ${value}`);
  }
}

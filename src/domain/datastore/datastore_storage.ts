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
 * The `storage/1` contract: content-addressed chunk storage for a v3
 * datastore (swamp-club#3237). See "v3 chunk storage (storage/1)" in
 * `design/enablers/datastores.md`.
 *
 * @module
 */

/** The contract string a {@link DatastoreStorage} declares. */
export const STORAGE_CONTRACT = "storage/1";

/** What a {@link DatastoreStorage} supports. */
export interface StorageCapabilities {
  /**
   * The largest chunk the backend stores, in bytes. Core cuts chunks of
   * `min(16 MiB, maxChunkBytes)`.
   */
  readonly maxChunkBytes: number;
  /**
   * True when the storage implements `touch`. Without it, core puts a
   * chunk it found present again, which refreshes it the same way.
   */
  readonly touch: boolean;
}

/** One chunk, as {@link DatastoreStorage.list} reports it. */
export interface StoredChunk {
  readonly sha256: string;
  /** When the chunk was last put or touched. */
  readonly lastModified: Date;
}

/**
 * Immutable chunks keyed by namespace and the SHA-256 of their bytes, stored
 * at `<prefix>/_blobs/<namespace>/sha256/<first two hex>/<sha256>`.
 *
 * `namespace` is the repository's namespace slug, or `_default` for an
 * unnamespaced datastore (solo, or a team datastore with no namespace).
 * `sha256` is 64 lowercase hex characters. Core verifies every chunk it
 * reads, so the storage need not hash anything. Every method rejects when
 * `signal` aborts.
 */
export interface DatastoreStorage {
  readonly contract: typeof STORAGE_CONTRACT;
  capabilities(): StorageCapabilities;
  /** The subset of `hashes` stored in `namespace`. */
  has(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>>;
  /**
   * Stores `bytes` under `sha256`, replacing any chunk already there, and
   * sets its `lastModified` to now. A reader never sees a partial chunk, and
   * concurrent puts of one hash leave one complete chunk.
   */
  put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
  /** The chunk's bytes, or null only when no such chunk exists. */
  get(
    namespace: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null>;
  /**
   * Sets `lastModified` to now for each of `hashes` that is stored, and
   * returns the ones that are not. Present exactly when
   * `capabilities().touch` is true.
   */
  touch?(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>>;
  /** Every chunk stored in `namespace`, in no particular order. */
  list(namespace: string, signal: AbortSignal): AsyncIterable<StoredChunk>;
  /** Removes the chunk; removing a missing chunk succeeds. */
  delete(namespace: string, sha256: string, signal: AbortSignal): Promise<void>;
}

/**
 * Removes a storage's own leftovers that are not chunks: the filesystem
 * storage's temp files from puts that never finished. Not part of
 * `storage/1`.
 */
export interface TempFileSweeper {
  /** Removes temp files last modified before `olderThan`; returns how many. */
  removeStaleTempFiles(
    namespace: string,
    olderThan: Date,
    signal: AbortSignal,
  ): Promise<number>;
}

/** A stored chunk's size and modification time, as {@link ChunkStatReader} reads them. */
export interface ChunkStat {
  /** The chunk's size in bytes. */
  readonly size: number;
  /** When the chunk was last put or touched. */
  readonly lastModified: Date;
}

/**
 * Reads stored chunks' sizes without reading their bytes, so a chunk a
 * crash left short (a torn chunk) counts as missing (swamp-club#3617). A
 * storage whose puts are atomic at the object level (a bucket) cannot tear
 * a chunk and need not offer it. Not part of `storage/1`.
 */
export interface ChunkStatReader {
  /**
   * The size and modification time of each of `hashes` stored in
   * `namespace`; a hash not stored is left out.
   */
  statChunks(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, ChunkStat>>;
}

/**
 * Makes chunk renames durable: a storage whose puts rename a synced temp
 * file into place offers it, so a commit naming a chunk lands only once the
 * chunk's directory entry survives a power loss (swamp-club#3617). Not part
 * of `storage/1`.
 */
export interface ChunkDirectorySync {
  /**
   * Syncs the directories holding `hashes` in `namespace`, and the
   * directories above them, so each chunk stored there survives a power
   * loss. Hashes need not be stored. A chunk whose name the storage knows
   * durable already (this process synced its directory since it was last
   * put, moved or deleted here) may be skipped.
   */
  syncChunkDirectories(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * Chunks written for one commit group and made durable together
 * (swamp-club#3617), from {@link ChunkStaging.stageChunks}. A put writes a
 * temp file and does not sync it; {@link commit} syncs every staged file at
 * once, then renames each into place. Their names are durable once
 * {@link ChunkDirectorySync.syncChunkDirectories} has run over them. Call
 * {@link discard} when done, whatever happened.
 */
export interface ChunkStage {
  /**
   * Writes `bytes` beside the chunk `sha256` without storing it: no reader
   * sees it until {@link commit}. A hash staged already is skipped.
   */
  put(sha256: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /**
   * Syncs every staged file, then renames each into place, replacing any
   * chunk there. On failure no staged file is left; chunks renamed before
   * it stay, harmless because no commit names them yet.
   */
  commit(signal: AbortSignal): Promise<void>;
  /** Removes every staged file not committed. */
  discard(): Promise<void>;
}

/**
 * Stages chunks so a commit group pays one batched barrier rather than one
 * sync per chunk (swamp-club#3617). Not part of `storage/1`.
 */
export interface ChunkStaging {
  /** A new, empty stage for chunks of `namespace`. */
  stageChunks(namespace: string): ChunkStage;
}

/**
 * A chunk moved aside by {@link ChunkQuarantine.quarantineChunk}: no longer
 * listed, read or deleted under its hash until it is put back. Each method
 * treats a moved-aside file that is gone (another process's temp-file sweep
 * removed it) as done.
 */
export interface QuarantinedChunk {
  /** The moved-aside bytes, or null when they are gone. */
  read(signal: AbortSignal): Promise<Uint8Array | null>;
  /** Removes the moved-aside bytes. */
  remove(signal: AbortSignal): Promise<void>;
  /**
   * Moves the bytes back under their hash, never replacing a chunk there:
   * one stored since the chunk was moved aside is kept, and the moved-aside
   * bytes are removed instead.
   */
  putBack(signal: AbortSignal): Promise<void>;
}

/**
 * Moves a chunk aside before deciding to delete it, so a writer that stores
 * the same hash meanwhile is never undone by the delete
 * (swamp-club#3617). Not part of `storage/1`.
 */
export interface ChunkQuarantine {
  /** Moves the chunk aside; undefined when it is not stored. */
  quarantineChunk(
    namespace: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<QuarantinedChunk | undefined>;
}

/** Whether `storage` reads chunk sizes ({@link ChunkStatReader}). */
export function isChunkStatReader<T extends object>(
  storage: T,
): storage is T & ChunkStatReader {
  return typeof (storage as Partial<ChunkStatReader>).statChunks ===
    "function";
}

/** Whether `storage` syncs chunk directories ({@link ChunkDirectorySync}). */
export function isChunkDirectorySync<T extends object>(
  storage: T,
): storage is T & ChunkDirectorySync {
  return typeof (storage as Partial<ChunkDirectorySync>)
    .syncChunkDirectories === "function";
}

/** Whether `storage` stages chunks for a batched barrier ({@link ChunkStaging}). */
export function isChunkStaging<T extends object>(
  storage: T,
): storage is T & ChunkStaging {
  return typeof (storage as Partial<ChunkStaging>).stageChunks === "function";
}

/** Whether `storage` moves chunks aside ({@link ChunkQuarantine}). */
export function isChunkQuarantine<T extends object>(
  storage: T,
): storage is T & ChunkQuarantine {
  return typeof (storage as Partial<ChunkQuarantine>).quarantineChunk ===
    "function";
}

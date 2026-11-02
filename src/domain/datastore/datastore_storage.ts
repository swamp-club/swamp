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

export const STORAGE_CONTRACT = "storage/1";

export interface StorageCapabilities {
  /** core cuts chunks of min(16 MiB, maxChunkBytes) */
  readonly maxChunkBytes: number;
  /**
   * without touch, core puts a chunk it found present again, which refreshes it
   * the same way
   */
  readonly touch: boolean;
}

export interface StoredChunk {
  readonly sha256: string;
  readonly lastModified: Date;
}

/**
 * namespace is _default for an unnamespaced datastore; core verifies every
 * chunk it reads, so the storage need not hash; every method rejects when
 * signal aborts
 */
export interface DatastoreStorage {
  readonly contract: typeof STORAGE_CONTRACT;
  capabilities(): StorageCapabilities;
  has(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>>;
  /**
   * a reader never sees a partial chunk, and concurrent puts of one hash leave
   * one complete chunk
   */
  put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
  get(
    namespace: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null>;
  /**
   * returns the hashes that are not stored; present exactly when
   * capabilities().touch is true
   */
  touch?(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>>;
  list(namespace: string, signal: AbortSignal): AsyncIterable<StoredChunk>;
  delete(namespace: string, sha256: string, signal: AbortSignal): Promise<void>;
}

export interface TempFileSweeper {
  removeStaleTempFiles(
    namespace: string,
    olderThan: Date,
    signal: AbortSignal,
  ): Promise<number>;
}

export interface ChunkStat {
  readonly size: number;
  readonly lastModified: Date;
}

/**
 * a chunk a crash left short (torn) counts as missing; a storage whose puts are
 * atomic at the object level need not offer it
 */
export interface ChunkStatReader {
  statChunks(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, ChunkStat>>;
}

/**
 * a storage whose puts rename a synced temp file into place offers it, so a
 * commit naming a chunk lands only once the chunk's directory entry survives a
 * power loss
 */
export interface ChunkDirectorySync {
  /**
   * a chunk whose name the storage knows durable already may be skipped; hashes
   * need not be stored
   */
  syncChunkDirectories(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * put writes a temp file without syncing; commit syncs every staged file at
 * once, then renames each into place; call discard when done, whatever happened
 */
export interface ChunkStage {
  /** no reader sees the chunk until commit; a hash staged already is skipped */
  put(sha256: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /**
   * on failure no staged file is left; chunks renamed before it stay, harmless
   * because no commit names them yet
   */
  commit(signal: AbortSignal): Promise<void>;
  discard(): Promise<void>;
}

export interface ChunkStaging {
  stageChunks(namespace: string): ChunkStage;
}

/**
 * each method treats a moved-aside file that is gone (another process's
 * temp-file sweep removed it) as done
 */
export interface QuarantinedChunk {
  read(signal: AbortSignal): Promise<Uint8Array | null>;
  remove(signal: AbortSignal): Promise<void>;
  /**
   * never replaces a chunk there: one stored since the move is kept and the
   * moved-aside bytes are removed
   */
  putBack(signal: AbortSignal): Promise<void>;
}

/**
 * moves a chunk aside before deciding to delete it, so a writer that stores the
 * same hash meanwhile is never undone by the delete
 */
export interface ChunkQuarantine {
  quarantineChunk(
    namespace: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<QuarantinedChunk | undefined>;
}

export function isChunkStatReader<T extends object>(
  storage: T,
): storage is T & ChunkStatReader {
  return typeof (storage as Partial<ChunkStatReader>).statChunks ===
    "function";
}

export function isChunkDirectorySync<T extends object>(
  storage: T,
): storage is T & ChunkDirectorySync {
  return typeof (storage as Partial<ChunkDirectorySync>)
    .syncChunkDirectories === "function";
}

export function isChunkStaging<T extends object>(
  storage: T,
): storage is T & ChunkStaging {
  return typeof (storage as Partial<ChunkStaging>).stageChunks === "function";
}

export function isChunkQuarantine<T extends object>(
  storage: T,
): storage is T & ChunkQuarantine {
  return typeof (storage as Partial<ChunkQuarantine>).quarantineChunk ===
    "function";
}

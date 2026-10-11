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

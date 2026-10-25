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
 * The upload ledger (swamp-club#3915): an in-memory, bounded record of the
 * chunks each principal uploaded to serve, kept as proof of possession for
 * the commits that later name them, and as the measure of each principal's
 * unreferenced upload bytes.
 *
 * - An entry holds within the grace window (`graceMs`, the chunk sweep's
 *   {@link DEFAULT_CHUNK_GRACE_MS} by default) of when it was recorded.
 * - {@link UploadLedger.release} marks chunks a commit now references: they
 *   stop counting toward the uploader's quota but still hold, so a retried
 *   commit is not refused.
 * - {@link UploadLedger.admit} refuses an upload that would take the
 *   principal past its unreferenced-byte quota or its entry cap.
 * - The ledger never holds more than `maxEntries` entries: recording past
 *   that evicts the oldest. An evicted upload no longer holds; its client
 *   uploads it again.
 *
 * The clock is the caller's: every call takes `now` (epoch milliseconds),
 * expected not to go backward. There are no timers; expired entries are
 * pruned on each call.
 *
 * @module
 */

import { DEFAULT_CHUNK_GRACE_MS } from "../../domain/datastore_v3/chunk_collector.ts";

/** Unreferenced bytes one principal may have uploaded: 2 GiB. */
export const DEFAULT_MAX_UNREFERENCED_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Ledger entries one principal may hold. */
export const DEFAULT_MAX_UPLOAD_ENTRIES_PER_PRINCIPAL = 20_000;

/** Ledger entries across every principal. */
export const DEFAULT_MAX_UPLOAD_LEDGER_ENTRIES = 200_000;

/** The options of an {@link UploadLedger}. */
export interface UploadLedgerOptions {
  /** How long an upload holds. {@link DEFAULT_CHUNK_GRACE_MS} by default. */
  readonly graceMs?: number;
  /** {@link DEFAULT_MAX_UNREFERENCED_UPLOAD_BYTES} by default. */
  readonly maxUnreferencedBytesPerPrincipal?: number;
  /** {@link DEFAULT_MAX_UPLOAD_ENTRIES_PER_PRINCIPAL} by default. */
  readonly maxEntriesPerPrincipal?: number;
  /** {@link DEFAULT_MAX_UPLOAD_LEDGER_ENTRIES} by default. */
  readonly maxEntries?: number;
}

/** The answer of {@link UploadLedger.admit}. */
export type UploadAdmission =
  | { readonly allowed: true }
  | {
    readonly allowed: false;
    /** `bytes`: past the unreferenced-byte quota; `entries`: the entry cap. */
    readonly reason: "bytes" | "entries";
    readonly unreferencedBytes: number;
    readonly limitBytes: number;
  };

interface Entry {
  readonly principalId: string;
  readonly namespace: string;
  readonly sha256: string;
  readonly size: number;
  readonly at: number;
  released: boolean;
}

interface PrincipalTally {
  entries: number;
  unreferencedBytes: number;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer: ${value}`);
  }
  return value;
}

function entryKey(principalId: string, namespace: string, sha256: string) {
  return `${principalId}\u0000${namespace}\u0000${sha256}`;
}

function chunkKey(namespace: string, sha256: string) {
  return `${namespace}\u0000${sha256}`;
}

/** See the module documentation. */
export class UploadLedger {
  readonly graceMs: number;
  readonly maxUnreferencedBytesPerPrincipal: number;
  readonly maxEntriesPerPrincipal: number;
  readonly maxEntries: number;
  /** In recording order, oldest first: a re-record moves to the end. */
  readonly #entries = new Map<string, Entry>();
  /** (namespace, sha256) → the entry keys that recorded it. */
  readonly #byChunk = new Map<string, Set<string>>();
  readonly #tallies = new Map<string, PrincipalTally>();

  constructor(options: UploadLedgerOptions = {}) {
    this.graceMs = positiveInteger(
      "graceMs",
      options.graceMs ?? DEFAULT_CHUNK_GRACE_MS,
    );
    this.maxUnreferencedBytesPerPrincipal = positiveInteger(
      "maxUnreferencedBytesPerPrincipal",
      options.maxUnreferencedBytesPerPrincipal ??
        DEFAULT_MAX_UNREFERENCED_UPLOAD_BYTES,
    );
    this.maxEntriesPerPrincipal = positiveInteger(
      "maxEntriesPerPrincipal",
      options.maxEntriesPerPrincipal ??
        DEFAULT_MAX_UPLOAD_ENTRIES_PER_PRINCIPAL,
    );
    this.maxEntries = positiveInteger(
      "maxEntries",
      options.maxEntries ?? DEFAULT_MAX_UPLOAD_LEDGER_ENTRIES,
    );
  }

  /** Entries held across every principal, expired ones included until pruned. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Whether `principalId` may upload `size` more bytes: refused when it
   * would take its unreferenced bytes past the quota, or when it already
   * holds its entry cap. Admission does not record anything.
   */
  admit(principalId: string, size: number, now: number): UploadAdmission {
    this.#prune(now);
    const tally = this.#tallies.get(principalId);
    const unreferencedBytes = tally?.unreferencedBytes ?? 0;
    const limitBytes = this.maxUnreferencedBytesPerPrincipal;
    if (unreferencedBytes + size > limitBytes) {
      return { allowed: false, reason: "bytes", unreferencedBytes, limitBytes };
    }
    if ((tally?.entries ?? 0) >= this.maxEntriesPerPrincipal) {
      return {
        allowed: false,
        reason: "entries",
        unreferencedBytes,
        limitBytes,
      };
    }
    return { allowed: true };
  }

  /**
   * Records that `principalId` uploaded the chunk `sha256` of `size` bytes
   * into `namespace` at `now`. Recording it again restarts its window and
   * counts it as unreferenced again. Evicts the oldest entries past
   * `maxEntries`.
   */
  record(
    principalId: string,
    namespace: string,
    sha256: string,
    size: number,
    now: number,
  ): void {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RangeError(`size must be a non-negative integer: ${size}`);
    }
    this.#prune(now);
    const key = entryKey(principalId, namespace, sha256);
    const existing = this.#entries.get(key);
    if (existing !== undefined) this.#delete(key, existing);
    while (this.#entries.size >= this.maxEntries) {
      const [oldestKey, oldest] = this.#entries.entries().next().value!;
      this.#delete(oldestKey, oldest);
    }
    this.#entries.set(key, {
      principalId,
      namespace,
      sha256,
      size,
      at: now,
      released: false,
    });
    const ck = chunkKey(namespace, sha256);
    let keys = this.#byChunk.get(ck);
    if (keys === undefined) {
      keys = new Set();
      this.#byChunk.set(ck, keys);
    }
    keys.add(key);
    const tally = this.#tally(principalId);
    tally.entries++;
    tally.unreferencedBytes += size;
  }

  /** Whether `principalId` uploaded the chunk within the grace window. */
  holds(
    principalId: string,
    namespace: string,
    sha256: string,
    now: number,
  ): boolean {
    this.#prune(now);
    const entry = this.#entries.get(entryKey(principalId, namespace, sha256));
    return entry !== undefined && !this.#expired(entry, now);
  }

  /**
   * Marks chunks a commit now references, for every principal that
   * uploaded them: their bytes stop counting toward the quota. They still
   * hold until their window ends.
   */
  release(namespace: string, sha256s: Iterable<string>): void {
    for (const sha256 of sha256s) {
      const keys = this.#byChunk.get(chunkKey(namespace, sha256));
      if (keys === undefined) continue;
      for (const key of keys) {
        const entry = this.#entries.get(key);
        if (entry === undefined || entry.released) continue;
        entry.released = true;
        this.#tally(entry.principalId).unreferencedBytes -= entry.size;
      }
    }
  }

  /** Bytes `principalId` uploaded within the window that no commit names. */
  unreferencedBytes(principalId: string, now: number): number {
    this.#prune(now);
    return this.#tallies.get(principalId)?.unreferencedBytes ?? 0;
  }

  #expired(entry: Entry, now: number): boolean {
    return now - entry.at >= this.graceMs;
  }

  /** Drops expired entries from the oldest end. */
  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (!this.#expired(entry, now)) break;
      this.#delete(key, entry);
    }
  }

  #tally(principalId: string): PrincipalTally {
    let tally = this.#tallies.get(principalId);
    if (tally === undefined) {
      tally = { entries: 0, unreferencedBytes: 0 };
      this.#tallies.set(principalId, tally);
    }
    return tally;
  }

  #delete(key: string, entry: Entry): void {
    this.#entries.delete(key);
    const ck = chunkKey(entry.namespace, entry.sha256);
    const keys = this.#byChunk.get(ck);
    keys?.delete(key);
    if (keys?.size === 0) this.#byChunk.delete(ck);
    const tally = this.#tallies.get(entry.principalId);
    if (tally === undefined) return;
    tally.entries--;
    if (!entry.released) tally.unreferencedBytes -= entry.size;
    if (tally.entries === 0) this.#tallies.delete(entry.principalId);
  }
}

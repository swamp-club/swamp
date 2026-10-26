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
 * unreferenced uploads.
 *
 * - An upload is reserved before its bytes are read
 *   ({@link UploadLedger.reserve}) and recorded against that reservation
 *   once stored ({@link UploadLedger.record}). A reservation counts toward
 *   every cap from the moment it is granted, so requests in flight
 *   together cannot pass them (swamp-club#3938); one that is never
 *   recorded is cancelled.
 * - An entry holds within the grace window (`graceMs`, the chunk sweep's
 *   {@link DEFAULT_CHUNK_GRACE_MS} by default) of when it was recorded.
 * - {@link UploadLedger.release} marks chunks a commit now references: they
 *   stop counting toward the uploader's byte quota and entry cap but still
 *   hold, so a retried commit is not refused.
 * - The ledger never holds more than `maxEntries` entries and reservations.
 *   A reservation at that bound makes room by evicting the oldest released
 *   entry, whose commit's partition vouches for its chunk instead. With none
 *   released, the principal with the most unreferenced uploads gives up its
 *   oldest one; when that is the caller, the caller is refused. One
 *   principal's uploads therefore never push out a lighter principal's.
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

/** Unreferenced uploads one principal may hold. */
export const DEFAULT_MAX_UPLOAD_ENTRIES_PER_PRINCIPAL = 20_000;

/** Ledger entries and reservations across every principal. */
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

/**
 * Room for one upload of a known size, granted by
 * {@link UploadLedger.reserve}. It counts toward the caps until it is
 * recorded or cancelled.
 */
export interface UploadReservation {
  readonly principalId: string;
  readonly size: number;
  /** Gives the room back. Does nothing once recorded or cancelled. */
  cancel(): void;
}

/** The answer of {@link UploadLedger.reserve}. */
export type UploadAdmission =
  | { readonly allowed: true; readonly reservation: UploadReservation }
  | {
    readonly allowed: false;
    /**
     * `bytes`: past the unreferenced-byte quota; `entries`: the
     * per-principal entry cap; `full`: the ledger is full and the caller
     * holds the most unreferenced uploads.
     */
    readonly reason: "bytes" | "entries" | "full";
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
  /** Entries recorded, released or not. */
  held: number;
  /** Keys of the unreleased entries, oldest first. */
  readonly unreferenced: Set<string>;
  /** Bytes of the unreleased entries. */
  unreferencedBytes: number;
  reservedEntries: number;
  reservedBytes: number;
}

class Reservation implements UploadReservation {
  settled = false;
  readonly #ledger: UploadLedger;
  readonly #cancel: (reservation: Reservation) => void;

  constructor(
    ledger: UploadLedger,
    readonly principalId: string,
    readonly size: number,
    cancel: (reservation: Reservation) => void,
  ) {
    this.#ledger = ledger;
    this.#cancel = cancel;
  }

  ownedBy(ledger: UploadLedger): boolean {
    return this.#ledger === ledger;
  }

  cancel(): void {
    this.#cancel(this);
  }
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
  /** Keys of released entries, in the order they were released. */
  readonly #released = new Set<string>();
  /** (namespace, sha256) → the entry keys that recorded it. */
  readonly #byChunk = new Map<string, Set<string>>();
  readonly #tallies = new Map<string, PrincipalTally>();
  #reserved = 0;

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

  /** Reservations granted and not yet recorded or cancelled. */
  get reserved(): number {
    return this.#reserved;
  }

  /**
   * Reserves room for `principalId` to upload `size` more bytes as one
   * entry. Refused when it would take the principal's unreferenced bytes
   * (reservations included) past the quota, when it already holds its
   * entry cap, or when the ledger is full and the principal holds the most
   * unreferenced uploads. Otherwise the reservation counts from now; the
   * caller records or cancels it.
   */
  reserve(principalId: string, size: number, now: number): UploadAdmission {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RangeError(`size must be a non-negative integer: ${size}`);
    }
    this.#prune(now);
    const tally = this.#tallies.get(principalId);
    const unreferencedBytes = (tally?.unreferencedBytes ?? 0) +
      (tally?.reservedBytes ?? 0);
    const limitBytes = this.maxUnreferencedBytesPerPrincipal;
    const refuse = (reason: "bytes" | "entries" | "full"): UploadAdmission => ({
      allowed: false,
      reason,
      unreferencedBytes,
      limitBytes,
    });
    if (unreferencedBytes + size > limitBytes) return refuse("bytes");
    if (this.#unreferencedCount(tally) >= this.maxEntriesPerPrincipal) {
      return refuse("entries");
    }
    if (
      this.#entries.size + this.#reserved >= this.maxEntries &&
      !this.#makeRoom(principalId)
    ) {
      return refuse("full");
    }
    const reservation = new Reservation(
      this,
      principalId,
      size,
      (r) => this.#unreserve(r),
    );
    const held = this.#tally(principalId);
    held.reservedEntries++;
    held.reservedBytes += size;
    this.#reserved++;
    return { allowed: true, reservation };
  }

  /**
   * Records, against `reservation`, that its principal uploaded the chunk
   * `sha256` of the reserved size into `namespace` at `now`. Recording a
   * chunk again restarts its window and counts it as unreferenced again.
   * The reservation is spent; the room it held becomes the entry's.
   */
  record(
    reservation: UploadReservation,
    namespace: string,
    sha256: string,
    now: number,
  ): void {
    if (
      !(reservation instanceof Reservation) || !reservation.ownedBy(this) ||
      reservation.settled
    ) {
      throw new Error("record needs a live reservation from this ledger");
    }
    const { principalId, size } = reservation;
    this.#unreserve(reservation);
    this.#prune(now);
    const key = entryKey(principalId, namespace, sha256);
    const existing = this.#entries.get(key);
    if (existing !== undefined) this.#delete(key, existing);
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
    tally.held++;
    tally.unreferenced.add(key);
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
   * uploaded them: they stop counting toward the quota and the entry cap.
   * They still hold until their window ends.
   */
  release(namespace: string, sha256s: Iterable<string>): void {
    for (const sha256 of sha256s) {
      const keys = this.#byChunk.get(chunkKey(namespace, sha256));
      if (keys === undefined) continue;
      for (const key of keys) {
        const entry = this.#entries.get(key);
        if (entry === undefined || entry.released) continue;
        entry.released = true;
        this.#released.add(key);
        const tally = this.#tally(entry.principalId);
        tally.unreferenced.delete(key);
        tally.unreferencedBytes -= entry.size;
      }
    }
  }

  /** Bytes `principalId` uploaded within the window that no commit names. */
  unreferencedBytes(principalId: string, now: number): number {
    this.#prune(now);
    return this.#tallies.get(principalId)?.unreferencedBytes ?? 0;
  }

  #unreferencedCount(tally: PrincipalTally | undefined): number {
    return tally === undefined
      ? 0
      : tally.unreferenced.size + tally.reservedEntries;
  }

  /**
   * Frees one slot for `principalId`: the oldest released entry, else the
   * oldest unreferenced entry of the principal with the most unreferenced
   * uploads, provided that is not the caller. False when neither exists.
   */
  #makeRoom(principalId: string): boolean {
    // A released entry's commit landed: the partition that references the
    // chunk now vouches for it on a retry, for a caller who may read that
    // partition. Every forwarded write needs admin until swamp-club#3922;
    // revisit this when that relaxes, since a writer may not be a reader.
    const [oldestReleased] = this.#released;
    if (oldestReleased !== undefined) {
      this.#delete(oldestReleased, this.#entries.get(oldestReleased)!);
      return true;
    }
    const own = this.#unreferencedCount(this.#tallies.get(principalId));
    let heaviest: PrincipalTally | undefined;
    let heaviestCount = own;
    for (const [id, tally] of this.#tallies) {
      if (id === principalId || tally.unreferenced.size === 0) continue;
      const count = this.#unreferencedCount(tally);
      if (count > heaviestCount) {
        heaviest = tally;
        heaviestCount = count;
      }
    }
    if (heaviest === undefined) return false;
    const [oldestKey] = heaviest.unreferenced;
    this.#delete(oldestKey, this.#entries.get(oldestKey)!);
    return true;
  }

  #unreserve(reservation: Reservation): void {
    if (reservation.settled) return;
    reservation.settled = true;
    this.#reserved--;
    const tally = this.#tallies.get(reservation.principalId);
    if (tally === undefined) return;
    tally.reservedEntries--;
    tally.reservedBytes -= reservation.size;
    this.#dropIfEmpty(reservation.principalId, tally);
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
      tally = {
        held: 0,
        unreferenced: new Set(),
        unreferencedBytes: 0,
        reservedEntries: 0,
        reservedBytes: 0,
      };
      this.#tallies.set(principalId, tally);
    }
    return tally;
  }

  #dropIfEmpty(principalId: string, tally: PrincipalTally): void {
    if (tally.held === 0 && tally.reservedEntries === 0) {
      this.#tallies.delete(principalId);
    }
  }

  #delete(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#released.delete(key);
    const ck = chunkKey(entry.namespace, entry.sha256);
    const keys = this.#byChunk.get(ck);
    keys?.delete(key);
    if (keys?.size === 0) this.#byChunk.delete(ck);
    const tally = this.#tallies.get(entry.principalId);
    if (tally === undefined) return;
    tally.held--;
    if (!entry.released) {
      tally.unreferenced.delete(key);
      tally.unreferencedBytes -= entry.size;
    }
    this.#dropIfEmpty(entry.principalId, tally);
  }
}

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
 * What one read-model catch-up did, for its span (swamp-club#3803): how
 * many commits and pages it applied, how many files it wrote, and how many
 * chunks and bytes it fetched from the storage and how long that took. A
 * first clone replays the whole feed, so these name where its time goes.
 *
 * `supersededBytes` counts content fetched for a put that a later commit of
 * the same catch-up overwrote or removed: bytes a clone fetched and then
 * replaced. It is measured only; the replay itself fetches every put.
 *
 * @module
 */

/** Counters for one catch-up; see the module documentation. */
export class CatchUpStats {
  commits = 0;
  pages = 0;
  filesWritten = 0;
  chunksFetched = 0;
  chunkBytes = 0;
  /** Milliseconds spent waiting on the storage for chunks, hashing included. */
  fetchMs = 0;
  /** Milliseconds spent writing content files, fetches included. */
  contentMs = 0;
  supersededBytes = 0;
  /** Milliseconds per named phase of the replay, such as `catalog`. */
  readonly phaseMs = new Map<string, number>();
  /** Named counts, such as catalog actions by kind. */
  readonly counts = new Map<string, number>();
  /** Bytes fetched for each key's latest written put, by namespace and key. */
  readonly #fetched = new Map<string, number>();

  /** Runs `fn`, adding its time to `phase`. */
  async time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.#add(phase, performance.now() - started);
    }
  }

  /** Runs `fn`, which does not await, adding its time to `phase`. */
  timeSync<T>(phase: string, fn: () => T): T {
    const started = performance.now();
    try {
      return fn();
    } finally {
      this.#add(phase, performance.now() - started);
    }
  }

  /** Adds `n` to the count `name`. */
  bump(name: string, n = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + n);
  }

  #add(phase: string, ms: number): void {
    this.phaseMs.set(phase, (this.phaseMs.get(phase) ?? 0) + ms);
  }

  /** Records that `key`'s file was written from `bytes` fetched bytes. */
  noteWritten(namespace: string, key: string, bytes: number): void {
    const id = `${namespace}\0${key}`;
    this.supersededBytes += this.#fetched.get(id) ?? 0;
    this.#fetched.set(id, bytes);
    this.filesWritten++;
  }

  /** Records that `key`'s file was removed. */
  noteRemoved(namespace: string, key: string): void {
    const id = `${namespace}\0${key}`;
    this.supersededBytes += this.#fetched.get(id) ?? 0;
    this.#fetched.delete(id);
    this.bump("files_removed");
  }

  /**
   * `stream`, counting each chunk it yields and the time spent waiting for
   * it. `ChunkStore.read` yields one chunk per pull.
   */
  count(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = stream.getReader();
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const started = performance.now();
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } finally {
          this.fetchMs += performance.now() - started;
        }
        if (result.done) {
          controller.close();
          return;
        }
        this.chunksFetched++;
        this.chunkBytes += result.value.length;
        controller.enqueue(result.value);
      },
      cancel: (reason) => reader.cancel(reason),
    }, { highWaterMark: 0 });
  }

  /** The span attributes for these counters. */
  attributes(): Record<string, number> {
    return {
      "swamp.datastore.v3.commits": this.commits,
      "swamp.datastore.v3.pages": this.pages,
      "swamp.datastore.v3.files_written": this.filesWritten,
      "swamp.datastore.v3.chunks_fetched": this.chunksFetched,
      "swamp.datastore.v3.chunk_bytes": this.chunkBytes,
      "swamp.datastore.v3.fetch_ms": Math.round(this.fetchMs),
      "swamp.datastore.v3.write_ms": Math.round(
        Math.max(0, this.contentMs - this.fetchMs),
      ),
      "swamp.datastore.v3.superseded_bytes": this.supersededBytes,
      ...Object.fromEntries(
        [...this.phaseMs].map((
          [phase, ms],
        ) => [`swamp.datastore.v3.${phase}_ms`, Math.round(ms)]),
      ),
      ...Object.fromEntries(
        [...this.counts].map((
          [name, n],
        ) => [`swamp.datastore.v3.${name}`, n]),
      ),
    };
  }
}

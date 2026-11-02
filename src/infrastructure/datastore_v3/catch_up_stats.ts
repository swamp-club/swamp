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
 * supersededBytes counts content fetched for a put that a later commit of the
 * same catch-up overwrote or removed; it is measured only, the replay still
 * fetches every put
 */

export class CatchUpStats {
  commits = 0;
  pages = 0;
  filesWritten = 0;
  chunksFetched = 0;
  chunkBytes = 0;
  fetchMs = 0;
  contentMs = 0;
  supersededBytes = 0;
  readonly phaseMs = new Map<string, number>();
  readonly counts = new Map<string, number>();
  readonly #fetched = new Map<string, number>();

  async time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.#add(phase, performance.now() - started);
    }
  }

  timeSync<T>(phase: string, fn: () => T): T {
    const started = performance.now();
    try {
      return fn();
    } finally {
      this.#add(phase, performance.now() - started);
    }
  }

  bump(name: string, n = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + n);
  }

  #add(phase: string, ms: number): void {
    this.phaseMs.set(phase, (this.phaseMs.get(phase) ?? 0) + ms);
  }

  noteWritten(namespace: string, key: string, bytes: number): void {
    const id = `${namespace}\0${key}`;
    this.supersededBytes += this.#fetched.get(id) ?? 0;
    this.#fetched.set(id, bytes);
    this.filesWritten++;
  }

  noteRemoved(namespace: string, key: string): void {
    const id = `${namespace}\0${key}`;
    this.supersededBytes += this.#fetched.get(id) ?? 0;
    this.#fetched.delete(id);
    this.bump("files_removed");
  }

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

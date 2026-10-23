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
 * One index read with independent callers. Its loader receives a signal owned
 * by the read, not by its first caller: it stops only once every caller leaves.
 * The owner decides which callers may share it and how long it remains visible.
 */
export class SharedIndexRead<T> {
  readonly #abort = new AbortController();
  #read: Promise<T> | undefined;
  #readers = 0;
  #settled = false;

  constructor(
    private readonly load: (signal: AbortSignal) => Promise<T>,
    private readonly onSettled: () => void = () => {},
  ) {}

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  async get(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    this.signal.throwIfAborted();
    this.#readers++;
    this.#read ??= Promise.resolve().then(async () => {
      try {
        this.signal.throwIfAborted();
        return await this.load(this.signal);
      } finally {
        this.#settled = true;
        this.onSettled();
      }
    });
    const stopped = Promise.withResolvers<never>();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--this.#readers === 0 && !this.#settled) {
        this.#abort.abort(signal?.reason);
      }
    };
    const onAbort = () => {
      release();
      stopped.reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // race observes the loader's rejection even if the last caller has
      // already left. No abandoned rejection or retained signal listener.
      return await Promise.race([this.#read, stopped.promise]);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      release();
    }
  }
}

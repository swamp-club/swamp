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
 * a filesystem datastore has no sync gate, so without this a manual gc could
 * delete the same files as a retention pass at the same time
 */
export class GcMutex {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  get held(): boolean {
    return this.#pending > 0;
  }

  /**
   * serve's retention pass stops at its next batch while a collection waits
   * behind it
   */
  get waiting(): boolean {
    return this.#pending > 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#pending++;
    try {
      await previous;
      return await fn();
    } finally {
      this.#pending--;
      release();
    }
  }

  async tryRun<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.held) return undefined;
    return await this.run(fn);
  }
}

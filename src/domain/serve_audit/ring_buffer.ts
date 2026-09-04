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

export class RingBuffer<T> {
  readonly #capacity: number;
  readonly #items: T[] = [];
  #head = 0;
  #seq = 0;

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error("RingBuffer capacity must be at least 1");
    }
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get length(): number {
    return this.#items.length;
  }

  get highSeq(): number {
    return this.#seq;
  }

  get oldestSeq(): number {
    if (this.#items.length === 0) return 0;
    return this.#seq - this.#items.length + 1;
  }

  push(item: T): number {
    this.#seq++;
    if (this.#items.length < this.#capacity) {
      this.#items.push(item);
    } else {
      this.#items[this.#head] = item;
      this.#head = (this.#head + 1) % this.#capacity;
    }
    return this.#seq;
  }

  readFrom(afterSeq: number): { items: T[]; throughSeq: number } {
    if (afterSeq >= this.#seq || this.#items.length === 0) {
      return { items: [], throughSeq: this.#seq };
    }

    const oldest = this.oldestSeq;
    const startSeq = Math.max(afterSeq + 1, oldest);
    const count = this.#seq - startSeq + 1;

    const result: T[] = [];
    for (let i = 0; i < count; i++) {
      const bufferIndex = (this.#head + (startSeq - oldest) + i) %
        this.#capacity;
      result.push(this.#items[bufferIndex]);
    }
    return { items: result, throughSeq: this.#seq };
  }
}

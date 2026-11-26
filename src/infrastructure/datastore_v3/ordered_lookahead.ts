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

type Outcome<R> =
  | { readonly kind: "resolved"; readonly value: R }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "held" };

const HELD = { kind: "held" } as const;

export interface OrderedLookaheadOptions<T, R> {
  readonly depth: number;
  readonly resolve: (item: T) => Promise<R>;
  /**
   * asked just before item would resolve ahead, with the values taken last and
   * resolved ahead before it; false holds it and every item after it until it
   * is taken
   */
  readonly runsAhead: (item: T, pending: readonly R[]) => boolean;
  /** whether the items after item may resolve while its taker works on it */
  readonly schedulesAfter: (item: T) => boolean;
  readonly fresh: (value: R) => boolean;
  readonly discard: (value: R) => void;
}

/**
 * resolves items one at a time in their order, up to depth ahead of the one
 * taken; an item held, stale or never resolved ahead is resolved by its take,
 * only once nothing else is resolving
 */
export class OrderedLookahead<T, R> {
  readonly #items: readonly T[];
  readonly #index = new Map<string, number>();
  readonly #options: OrderedLookaheadOptions<T, R>;
  readonly #ahead = new Map<number, Promise<Outcome<R>>>();
  readonly #resolved = new Map<number, R>();
  #tail: Promise<boolean> = Promise.resolve(true);
  #taken = 0;
  #next = 0;
  #current: R | undefined;

  constructor(
    entries: readonly { readonly key: string; readonly item: T }[],
    options: OrderedLookaheadOptions<T, R>,
  ) {
    this.#items = entries.map((entry) => entry.item);
    entries.forEach((entry, i) => this.#index.set(entry.key, i));
    this.#options = options;
  }

  /**
   * items skipped over are dropped, with any error their resolution met; an
   * unknown key, or one already passed, resolves item on its own
   */
  async take(key: string, item: T): Promise<R> {
    const index = this.#index.get(key);
    if (index === undefined || index < this.#taken) {
      await this.#reset();
      this.#current = await this.#options.resolve(item);
      return this.#current;
    }
    for (let i = this.#taken; i < index; i++) await this.#drop(i);
    this.#taken = index + 1;
    const outcome = await (this.#ahead.get(index) ?? HELD);
    this.#ahead.delete(index);
    this.#resolved.delete(index);
    // the items after a failure are held, so nothing goes on resolving
    if (outcome.kind === "failed") throw outcome.error;
    let value: R;
    if (outcome.kind === "resolved" && this.#options.fresh(outcome.value)) {
      value = outcome.value;
    } else {
      if (outcome.kind === "resolved") this.#options.discard(outcome.value);
      await this.#reset();
      value = await this.#options.resolve(item);
    }
    this.#current = value;
    if (this.#options.schedulesAfter(this.#items[index])) this.#schedule();
    return value;
  }

  async settle(): Promise<void> {
    await this.#reset();
  }

  #schedule(): void {
    const { depth, runsAhead, resolve } = this.#options;
    while (
      this.#next < this.#items.length && this.#next < this.#taken + depth
    ) {
      const i = this.#next++;
      const item = this.#items[i];
      const outcome = this.#tail.then(async (runs): Promise<Outcome<R>> => {
        try {
          if (!runs || !runsAhead(item, this.#pending(i))) return HELD;
          const value = await resolve(item);
          this.#resolved.set(i, value);
          return { kind: "resolved", value };
        } catch (error) {
          return { kind: "failed", error };
        }
      });
      this.#ahead.set(i, outcome);
      this.#tail = outcome.then((o) => o.kind === "resolved");
    }
  }

  #pending(before: number): R[] {
    const pending: R[] = this.#current === undefined ? [] : [this.#current];
    for (const [i, value] of this.#resolved) {
      if (i < before) pending.push(value);
    }
    return pending;
  }

  async #drop(i: number): Promise<void> {
    const outcome = await (this.#ahead.get(i) ?? HELD);
    this.#ahead.delete(i);
    this.#resolved.delete(i);
    if (outcome.kind === "resolved") this.#options.discard(outcome.value);
  }

  async #reset(): Promise<void> {
    await this.#tail;
    for (const i of [...this.#ahead.keys()]) await this.#drop(i);
    this.#next = this.#taken;
    this.#tail = Promise.resolve(true);
  }
}

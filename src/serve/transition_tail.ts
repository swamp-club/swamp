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
 * the datastore has no compare-and-swap, so a transition runs after every
 * earlier one on its chain settled; a keyed one shares a chain only with its
 * record's, so a finished step never waits on another's work
 */

import { withSpan } from "../infrastructure/tracing/mod.ts";
import { observeExecution } from "../domain/remote/observability.ts";

export type TransitionTailName = "dispatch" | "gateway";

interface Chain {
  tail: Promise<unknown>;
  pending: number;
}

export class TransitionTail {
  readonly #name: TransitionTailName;
  readonly #unkeyed: Chain = { tail: Promise.resolve(), pending: 0 };
  readonly #keyed = new Map<string, Chain>();
  #pending = 0;

  constructor(name: TransitionTailName) {
    this.#name = name;
  }

  /**
   * operation is a fixed label, never a worker, token or data name; key never
   * reaches the span. fn starts a few microtasks after the previous settles, so
   * tests must wait for the effect.
   */
  run<T>(operation: string, fn: () => Promise<T>, key?: string): Promise<T> {
    const chain = this.#chainFor(key);
    const ahead = chain.pending++;
    this.#pending++;
    const enqueuedAt = performance.now();
    const waiting = observeExecution("transition.wait", {
      "swamp.transition.tail": this.#name,
    });
    const traced = () =>
      waiting.run(() => {
        waiting.end("ok");
        return (
          withSpan(
            "swamp.serve.transition",
            {
              "swamp.transition.tail": this.#name,
              "swamp.transition.operation": operation,
              "swamp.transition.queue_depth": ahead,
              "swamp.transition.queue_wait_ms": Math.round(
                performance.now() - enqueuedAt,
              ),
            },
            // An async wrapper turns a synchronous throw into a rejection, so the
            // span still ends and the pending counts still drop.
            async () => await fn(),
          ).finally(() => {
            chain.pending--;
            this.#pending--;
            // The transition settled, so a later one for this key may start
            // on a fresh chain without overlapping it.
            if (key !== undefined && chain.pending === 0) {
              this.#keyed.delete(key);
            }
          })
        );
      });
    const next = chain.tail.then(traced, traced);
    chain.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  async settled(): Promise<void> {
    while (this.#pending > 0) {
      await Promise.all(
        [this.#unkeyed, ...this.#keyed.values()].map((chain) => chain.tail),
      );
    }
  }

  #chainFor(key: string | undefined): Chain {
    if (key === undefined) return this.#unkeyed;
    let chain = this.#keyed.get(key);
    if (chain === undefined) {
      chain = { tail: Promise.resolve(), pending: 0 };
      this.#keyed.set(key, chain);
    }
    return chain;
  }

  get keyedChainCountForTesting(): number {
    return this.#keyed.size;
  }
}

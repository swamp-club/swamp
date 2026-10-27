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
 * The serialized chains serve's control-plane transitions run on. Serve is
 * the sole writer of its worker, token, lease and pending-dispatch records
 * and the datastore has no compare-and-swap, so a transition runs only after
 * every earlier one on its chain settled (design/enablers/remote-execution.md).
 *
 * A transition run with a key shares a chain only with transitions of that
 * key: each key names one record, so transitions of different records run at
 * once and a finished step never waits on another step's bookkeeping
 * (swamp-club#4038). A transition run without a key shares the one unkeyed
 * chain. A key's chain is dropped once nothing on it is pending.
 *
 * Each transition runs in a `swamp.serve.transition` span that records how
 * long it waited for its turn and how many transitions were ahead of it on
 * its chain, so a request waiting on the chain shows the queue rather than
 * an unexplained gap (swamp-club#3755). The span starts in the enqueuer's
 * context, so it nests under the request or run that waits on it.
 */

import { withSpan } from "../infrastructure/tracing/mod.ts";
import { observeExecution } from "../domain/remote/observability.ts";

/** Which of serve's two tails a transition runs on. */
export type TransitionTailName = "dispatch" | "gateway";

interface Chain {
  tail: Promise<unknown>;
  /** Transitions enqueued on this chain and not yet settled. */
  pending: number;
}

export class TransitionTail {
  readonly #name: TransitionTailName;
  readonly #unkeyed: Chain = { tail: Promise.resolve(), pending: 0 };
  readonly #keyed = new Map<string, Chain>();
  /** Transitions enqueued on any chain and not yet settled. */
  #pending = 0;

  constructor(name: TransitionTailName) {
    this.#name = name;
  }

  /**
   * Runs `fn` after every earlier transition on its chain settled, whether
   * it succeeded or not, and settles as `fn` does. `operation` names the
   * transition in its span; it is a fixed label, never a worker, token or
   * data name. `key` is the record the transition writes; it never reaches
   * the span.
   *
   * `fn` starts a few microtasks after the previous transition settles (the
   * span wraps it), so a test must wait for a transition's effect rather
   * than expect it within the same tick.
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

  /**
   * Resolves once every transition enqueued, on any chain and including any
   * enqueued while waiting, has settled (swamp-club#3854).
   */
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

  /** Test seam: how many keys have a chain. */
  get keyedChainCountForTesting(): number {
    return this.#keyed.size;
  }
}

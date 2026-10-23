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
 * The serialized chain serve's control-plane transitions run on. Serve is
 * the sole writer of its worker, token, lease and pending-dispatch records
 * and the datastore has no compare-and-swap, so each transition runs only
 * after every earlier one settled (design/enablers/remote-execution.md).
 *
 * Each transition runs in a `swamp.serve.transition` span that records how
 * long it waited for its turn and how many transitions were ahead of it, so
 * a request waiting on the chain shows the queue rather than an unexplained
 * gap (swamp-club#3755). The span starts in the enqueuer's context, so it
 * nests under the request or run that waits on it.
 */

import { withSpan } from "../infrastructure/tracing/mod.ts";
import { observeExecution } from "../domain/remote/observability.ts";

/** Which of serve's two chains a transition runs on. */
export type TransitionTailName = "dispatch" | "gateway";

export class TransitionTail {
  readonly #name: TransitionTailName;
  #tail: Promise<unknown> = Promise.resolve();
  /** Transitions enqueued and not yet settled. */
  #pending = 0;

  constructor(name: TransitionTailName) {
    this.#name = name;
  }

  /**
   * Runs `fn` after every earlier transition settled, whether it succeeded
   * or not, and settles as `fn` does. `operation` names the transition in
   * its span; it is a fixed label, never a worker, token or data name.
   *
   * `fn` starts a few microtasks after the previous transition settles (the
   * span wraps it), so a test must wait for a transition's effect rather
   * than expect it within the same tick.
   */
  run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const ahead = this.#pending++;
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
            // span still ends and the pending count still drops.
            async () => await fn(),
          ).finally(() => {
            this.#pending--;
          })
        );
      });
    const next = this.#tail.then(traced, traced);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Transitions enqueued and not yet settled. */
  get pending(): number {
    return this.#pending;
  }

  /**
   * Resolves once every transition enqueued, including any enqueued while
   * waiting, has settled (swamp-club#3854).
   */
  async settled(): Promise<void> {
    while (this.#pending > 0) {
      const tail = this.#tail;
      await tail;
      // A count the chain no longer moves must not spin on microtasks: a
      // full turn lets a caller's timer still fire.
      if (tail === this.#tail && this.#pending > 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }
}

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

import { AsyncQueue } from "./async_queue.ts";
import { Semaphore } from "./semaphore.ts";

/** Options for {@link merge} and {@link mergeWithConcurrency}. */
export interface MergeOptions {
  /**
   * When the signal aborts, let the source streams that already started run
   * to their end and keep yielding their items, and complete once they have,
   * instead of closing the merged stream at once. A stream that has not
   * started yet still never starts, and an error a stream throws after the
   * abort is swallowed without cutting its siblings short. A single stream
   * already runs to its end, but it is passed through whatever the signal, so
   * it starts even when the signal has already aborted: a caller that must
   * not start it then guards the stream itself.
   */
  finishStartedOnAbort?: boolean;
}

/**
 * Merges multiple async iterables into a single stream.
 * Items are yielded in arrival order (interleaved).
 * The merged stream completes when all source streams have completed.
 *
 * When an optional `signal` is provided and aborted, the queue is closed
 * early and `for await` exits. Child generators receive signals independently
 * through their own contexts. With `finishStartedOnAbort`, the streams run on
 * to their end instead (see {@link MergeOptions}).
 */
export async function* merge<T>(
  streams: AsyncIterable<T>[],
  signal?: AbortSignal,
  options?: MergeOptions,
): AsyncGenerator<T> {
  if (streams.length === 0) return;
  if (streams.length === 1) {
    yield* streams[0];
    return;
  }

  const queue = new AsyncQueue<T>();
  let remaining = streams.length;
  let firstStreamError: unknown;
  let errorWasAbortInduced = false;

  const finishStarted = options?.finishStartedOnAbort ?? false;

  // Close queue early when signal aborts
  let abortHandler: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) {
      return;
    }
    if (!finishStarted) {
      abortHandler = () => queue.abort(signal.reason);
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  const drainStream = async (stream: AsyncIterable<T>) => {
    try {
      for await (const item of stream) {
        try {
          queue.push(item);
        } catch {
          // Queue already closed (abort or sibling stream error) — stop draining
          return;
        }
      }
    } catch (error) {
      // Source stream threw — record and abort the queue so the consumer exits
      if (firstStreamError === undefined) {
        firstStreamError = error;
        errorWasAbortInduced = signal?.aborted ?? false;
      }
      // After the abort the error is swallowed anyway, so leave the queue
      // open for the siblings that are still finishing.
      if (!finishStarted || !signal?.aborted) {
        queue.abort();
      }
    } finally {
      remaining--;
      if (remaining === 0) {
        queue.close();
      }
    }
  };

  // Spawn concurrent drain tasks for each stream
  const tasks = streams.map((s) => drainStream(s));

  // Yield items as they arrive
  try {
    yield* queue;
  } finally {
    if (abortHandler && signal) {
      signal.removeEventListener("abort", abortHandler);
    }
    // When the signal is aborted, skip waiting for drain tasks so the
    // consumer can proceed to cancellation handling immediately. The
    // drain tasks continue in the background until their generators
    // finish — same trade-off as manual cancel. Streams asked to finish
    // have already ended by the time the queue closes.
    if (finishStarted || !signal?.aborted) {
      await Promise.allSettled(tasks);
    }
  }
  if (firstStreamError !== undefined && !errorWasAbortInduced) {
    throw firstStreamError;
  }
}

/**
 * Concurrency-limited variant of {@link merge}. At most `limit` source
 * streams drain concurrently; additional streams are queued until a permit
 * is released. When `limit` is `undefined` or `0`, delegates to the
 * unbounded {@link merge} — no semaphore overhead on the default path.
 * With `finishStartedOnAbort`, a stream still waiting for a permit when the
 * signal aborts never starts.
 */
export async function* mergeWithConcurrency<T>(
  streams: AsyncIterable<T>[],
  limit: number | undefined,
  signal?: AbortSignal,
  options?: MergeOptions,
): AsyncGenerator<T> {
  if (!limit || limit <= 0 || limit >= streams.length) {
    yield* merge(streams, signal, options);
    return;
  }

  const queue = new AsyncQueue<T>();
  let remaining = streams.length;
  const sem = new Semaphore(limit);
  let firstStreamError: unknown;
  let errorWasAbortInduced = false;

  const finishStarted = options?.finishStartedOnAbort ?? false;

  let abortHandler: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) return;
    if (!finishStarted) {
      abortHandler = () => queue.abort(signal.reason);
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  const drainStream = async (stream: AsyncIterable<T>) => {
    try {
      await sem.acquire(signal);
    } catch {
      // Aborted while queued: this stream never starts, but still counts
      // toward closing the queue for streams that finish after the abort.
      remaining--;
      if (remaining === 0) {
        queue.close();
      }
      return;
    }
    try {
      for await (const item of stream) {
        try {
          queue.push(item);
        } catch {
          // Queue already closed (abort or sibling stream error) — stop draining
          return;
        }
      }
    } catch (error) {
      // Source stream threw — record and abort the queue so the consumer exits
      if (firstStreamError === undefined) {
        firstStreamError = error;
        errorWasAbortInduced = signal?.aborted ?? false;
      }
      // After the abort the error is swallowed anyway, so leave the queue
      // open for the siblings that are still finishing.
      if (!finishStarted || !signal?.aborted) {
        queue.abort();
      }
    } finally {
      sem.release();
      remaining--;
      if (remaining === 0) {
        queue.close();
      }
    }
  };

  const tasks = streams.map((s) => drainStream(s));

  try {
    yield* queue;
  } finally {
    if (abortHandler && signal) {
      signal.removeEventListener("abort", abortHandler);
    }
    if (finishStarted || !signal?.aborted) {
      await Promise.allSettled(tasks);
    }
  }
  if (firstStreamError !== undefined && !errorWasAbortInduced) {
    throw firstStreamError;
  }
}

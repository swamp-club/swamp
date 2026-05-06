// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/**
 * Merges multiple async iterables into a single stream.
 * Items are yielded in arrival order (interleaved).
 * The merged stream completes when all source streams have completed.
 *
 * When an optional `signal` is provided and aborted, the queue is closed
 * early and `for await` exits. Child generators receive signals independently
 * through their own contexts.
 */
export async function* merge<T>(
  streams: AsyncIterable<T>[],
  signal?: AbortSignal,
): AsyncGenerator<T> {
  if (streams.length === 0) return;
  if (streams.length === 1) {
    yield* streams[0];
    return;
  }

  const queue = new AsyncQueue<T>();
  let remaining = streams.length;

  // Close queue early when signal aborts
  let abortHandler: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) {
      return;
    }
    abortHandler = () => queue.abort(signal.reason);
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  const drainStream = async (stream: AsyncIterable<T>) => {
    try {
      for await (const item of stream) {
        queue.push(item);
      }
    } catch {
      // Silently handle errors from closed queue (abort scenario)
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
    // Ensure all drain tasks complete (they may throw)
    await Promise.allSettled(tasks);
  }
}

/**
 * Concurrency-limited variant of {@link merge}. At most `limit` source
 * streams drain concurrently; additional streams are queued until a permit
 * is released. When `limit` is `undefined` or `0`, delegates to the
 * unbounded {@link merge} — no semaphore overhead on the default path.
 */
export async function* mergeWithConcurrency<T>(
  streams: AsyncIterable<T>[],
  limit: number | undefined,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  if (!limit || limit <= 0 || limit >= streams.length) {
    yield* merge(streams, signal);
    return;
  }

  const queue = new AsyncQueue<T>();
  let remaining = streams.length;
  const sem = new Semaphore(limit);

  let abortHandler: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) return;
    abortHandler = () => queue.abort(signal.reason);
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  const drainStream = async (stream: AsyncIterable<T>) => {
    try {
      await sem.acquire(signal);
    } catch {
      return;
    }
    try {
      for await (const item of stream) {
        queue.push(item);
      }
    } catch {
      // Silently handle errors from closed queue (abort scenario)
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
    await Promise.allSettled(tasks);
  }
}

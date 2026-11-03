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

export interface MergeOptions {
  /**
   * on abort, started streams run to their end; unstarted ones never start. A
   * single stream is passed through whatever the signal, so a caller that must
   * not start it guards it
   */
  finishStartedOnAbort?: boolean;
}

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
          return;
        }
      }
    } catch (error) {
      if (firstStreamError === undefined) {
        firstStreamError = error;
        errorWasAbortInduced = signal?.aborted ?? false;
      }
      // after abort the error is swallowed anyway, so leave the queue open for
      // siblings still finishing
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

  const tasks = streams.map((s) => drainStream(s));

  try {
    yield* queue;
  } finally {
    if (abortHandler && signal) {
      signal.removeEventListener("abort", abortHandler);
    }
    // on abort, skip waiting for drain tasks so cancellation handling proceeds;
    // they keep running in the background until their generators finish
    if (finishStarted || !signal?.aborted) {
      await Promise.allSettled(tasks);
    }
  }
  if (firstStreamError !== undefined && !errorWasAbortInduced) {
    throw firstStreamError;
  }
}

export async function* mergeWithConcurrency<T>(
  streams: AsyncIterable<T>[],
  limit: number | undefined,
  signal?: AbortSignal,
  options?: MergeOptions,
): AsyncGenerator<T> {
  yield* mergeGated(
    streams.map((stream) => ({ stream, gates: ["limit"] })),
    new Map([["limit", limit ?? 0]]),
    signal,
    options,
  );
}

export interface GatedStream<T> {
  stream: AsyncIterable<T>;
  // Acquired in this order before the stream starts and released when it ends.
  // Streams sharing two gates must name them in the same order, or two can
  // each hold one and wait on the other forever.
  gates: readonly string[];
}

/**
 * Each gate named in `limits` with a positive limit caps how many of the
 * streams naming it run at once; any other gate name is unbounded.
 */
export async function* mergeGated<T>(
  entries: readonly GatedStream<T>[],
  limits: ReadonlyMap<string, number>,
  signal?: AbortSignal,
  options?: MergeOptions,
): AsyncGenerator<T> {
  const users = new Map<string, number>();
  for (const entry of entries) {
    for (const gate of entry.gates) {
      users.set(gate, (users.get(gate) ?? 0) + 1);
    }
  }
  // A gate no tighter than the number of streams using it never blocks.
  const semaphores = new Map<string, Semaphore>();
  for (const [gate, count] of users) {
    const limit = limits.get(gate);
    if (limit && limit > 0 && limit < count) {
      semaphores.set(gate, new Semaphore(limit));
    }
  }
  if (semaphores.size === 0) {
    yield* merge(entries.map((entry) => entry.stream), signal, options);
    return;
  }

  const queue = new AsyncQueue<T>();
  let remaining = entries.length;
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

  const releaseAll = (held: Semaphore[]): void => {
    for (let i = held.length - 1; i >= 0; i--) held[i].release();
  };

  const drainStream = async (entry: GatedStream<T>) => {
    const held: Semaphore[] = [];
    try {
      for (const gate of entry.gates) {
        const sem = semaphores.get(gate);
        if (!sem) continue;
        await sem.acquire(signal);
        held.push(sem);
      }
    } catch {
      // aborted while queued: the gates already taken go back, the stream
      // never starts but still counts toward closing the queue
      releaseAll(held);
      remaining--;
      if (remaining === 0) {
        queue.close();
      }
      return;
    }
    try {
      for await (const item of entry.stream) {
        try {
          queue.push(item);
        } catch {
          return;
        }
      }
    } catch (error) {
      if (firstStreamError === undefined) {
        firstStreamError = error;
        errorWasAbortInduced = signal?.aborted ?? false;
      }
      // after abort the error is swallowed anyway, so leave the queue open for
      // siblings still finishing
      if (!finishStarted || !signal?.aborted) {
        queue.abort();
      }
    } finally {
      releaseAll(held);
      remaining--;
      if (remaining === 0) {
        queue.close();
      }
    }
  };

  const tasks = entries.map((entry) => drainStream(entry));

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

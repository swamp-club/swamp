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

/**
 * Merges multiple async iterables into a single stream.
 * Items are yielded in arrival order (interleaved).
 * The merged stream completes when all source streams have completed.
 */
export async function* merge<T>(
  streams: AsyncIterable<T>[],
): AsyncGenerator<T> {
  if (streams.length === 0) return;
  if (streams.length === 1) {
    yield* streams[0];
    return;
  }

  const queue = new AsyncQueue<T>();
  let remaining = streams.length;

  const drainStream = async (stream: AsyncIterable<T>) => {
    try {
      for await (const item of stream) {
        queue.push(item);
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
    // Ensure all drain tasks complete (they may throw)
    await Promise.allSettled(tasks);
  }
}

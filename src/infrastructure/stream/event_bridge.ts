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

export async function* withEventBridge<TEvent, TResult>(
  fn: (push: (event: TEvent) => void) => Promise<TResult>,
): AsyncGenerator<TEvent, TResult> {
  const queue = new AsyncQueue<TEvent>();
  let result!: TResult;
  const promise = fn((event) => queue.push(event))
    .then((r) => {
      result = r;
    })
    .finally(() => {
      queue.close();
    });
  try {
    for await (const event of queue) {
      yield event;
    }
    await promise;
    return result;
  } finally {
    // an early return skips `await promise`, so close the queue to signal the
    // executor and absorb any rejection to avoid an unhandled one
    queue.close();
    await promise.catch(() => {});
  }
}

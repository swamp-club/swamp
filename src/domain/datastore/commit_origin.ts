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

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * the writer behind a commit: a workflow step, so commits of steps running at
 * the same time can be sent together while each step's stay in order
 */
export interface CommitOrigin {
  readonly token: object;
  /** on the monotonic clock: what was recorded before it began, it may need */
  readonly opened: number;
}

const scope = new AsyncLocalStorage<CommitOrigin>();

export function newCommitOrigin(): CommitOrigin {
  return { token: {}, opened: performance.now() };
}

export function currentCommitOrigin(): CommitOrigin | undefined {
  return scope.getStore();
}

export function runInCommitOrigin<T>(origin: CommitOrigin, fn: () => T): T {
  return scope.run(origin, fn);
}

/** each resume runs in the origin, as a step's generator is driven from outside */
export async function* bindGeneratorToCommitOrigin<T, TReturn>(
  origin: CommitOrigin,
  generator: AsyncGenerator<T, TReturn>,
): AsyncGenerator<T, TReturn> {
  let done = false;
  try {
    while (true) {
      let result: IteratorResult<T, TReturn>;
      try {
        result = await scope.run(origin, () => generator.next());
      } catch (error) {
        done = true;
        throw error;
      }
      if (result.done) {
        done = true;
        return result.value;
      }
      yield result.value;
    }
  } finally {
    if (!done) {
      await scope.run(origin, () => generator.return(undefined as TReturn));
    }
  }
}

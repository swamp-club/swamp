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
 * a read that does not watch the service's signal, or only between records,
 * must not hold shutdown for as long as it takes
 */

export const STOPPED = Symbol("stopped");

export interface Stopped {
  readonly stopped: Promise<typeof STOPPED>;
  release(): void;
}

export function stoppedBy(signal: AbortSignal): Stopped {
  const { promise: stopped, resolve } = Promise.withResolvers<
    typeof STOPPED
  >();
  const onAbort = () => resolve(STOPPED);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    stopped,
    release: () => signal.removeEventListener("abort", onAbort),
  };
}

/**
 * once stopped resolves first, work is let go: its outcome, failure included,
 * is not wanted
 */
export function untilStopped<T>(
  work: Promise<T>,
  stopped: Promise<typeof STOPPED>,
): Promise<T | typeof STOPPED> {
  work.catch(() => {});
  return Promise.race([work, stopped]);
}

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
 * Letting go of work a background service no longer wants once it is
 * stopped: a read that does not watch the service's signal, or watches it
 * only between records, must not hold shutdown for as long as it takes
 * (swamp-club#3468, swamp-club#3472).
 */

/** What {@link untilStopped} settles with when the stop comes first. */
export const STOPPED = Symbol("stopped");

/** A promise that resolves once a signal aborts. */
export interface Stopped {
  /** Resolves with {@link STOPPED} once the signal aborts; never rejects. */
  readonly stopped: Promise<typeof STOPPED>;
  /** Stops listening to the signal. */
  release(): void;
}

/**
 * Resolves with {@link STOPPED} once `signal` aborts, at once if it already
 * has. Call `release` when done, so the listener does not outlive the work.
 */
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
 * Settles as `work` does, or with {@link STOPPED} once `stopped` resolves
 * first. `work` is then let go: its outcome, failure included, is no longer
 * wanted.
 */
export function untilStopped<T>(
  work: Promise<T>,
  stopped: Promise<typeof STOPPED>,
): Promise<T | typeof STOPPED> {
  work.catch(() => {});
  return Promise.race([work, stopped]);
}

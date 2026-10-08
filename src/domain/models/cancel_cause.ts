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

/** The cause recorded when a run's timeout stopped it. */
export const TIMED_OUT_CAUSE = "timed out";

/** The cause recorded when swamp's own cleanup grace cut a cleanup step off. */
export const CLEANUP_GRACE_EXPIRED_CAUSE = "cleanup grace expired";

const cleanupGraceSignals = new WeakSet<AbortSignal>();

/**
 * A signal that aborts once the cleanup grace of `ms` runs out. It is
 * `AbortSignal.timeout(ms)`, remembered so {@link cancelCause} can tell swamp
 * cutting a cleanup step off apart from a timeout the user asked for. A signal
 * derived from it (`AbortSignal.any`) is not remembered and reads as a plain
 * timeout.
 */
export function cleanupGraceSignal(ms: number): AbortSignal {
  const signal = AbortSignal.timeout(ms);
  cleanupGraceSignals.add(signal);
  return signal;
}

/** Whether `signal` is one {@link cleanupGraceSignal} made. */
export function isCleanupGraceSignal(signal: AbortSignal): boolean {
  return cleanupGraceSignals.has(signal);
}

/**
 * Why an aborted `signal` cancelled a method run, for the run's records:
 * the cleanup grace running out, a timeout, or the message of the reason a
 * caller gave (`controller.abort(new Error(reason))`). Returns `undefined`
 * for an abort that names no cause, and for a signal that has not aborted.
 */
export function cancelCause(signal: AbortSignal): string | undefined {
  if (!signal.aborted) return undefined;
  if (isCleanupGraceSignal(signal)) return CLEANUP_GRACE_EXPIRED_CAUSE;
  const reason: unknown = signal.reason;
  if (!(reason instanceof Error)) return undefined;
  if (reason.name === "TimeoutError") return TIMED_OUT_CAUSE;
  if (reason.name === "AbortError") return undefined;
  return reason.message || undefined;
}

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

export const TIMED_OUT_CAUSE = "timed out";

export const CLEANUP_GRACE_EXPIRED_CAUSE = "cleanup grace expired";

const cleanupGraceSignals = new WeakSet<AbortSignal>();

/**
 * AbortSignal.timeout, remembered so cancelCause can tell swamp cutting a
 * cleanup step off from a user-requested timeout; a signal derived via
 * AbortSignal.any is not remembered and reads as a timeout
 */
export function cleanupGraceSignal(ms: number): AbortSignal {
  return asCleanupGrace(AbortSignal.timeout(ms));
}

export function asCleanupGrace(signal: AbortSignal): AbortSignal {
  cleanupGraceSignals.add(signal);
  return signal;
}

export function isCleanupGraceSignal(signal: AbortSignal): boolean {
  return cleanupGraceSignals.has(signal);
}

export function cancelCause(signal: AbortSignal): string | undefined {
  if (!signal.aborted) return undefined;
  if (isCleanupGraceSignal(signal)) return CLEANUP_GRACE_EXPIRED_CAUSE;
  const reason: unknown = signal.reason;
  if (!(reason instanceof Error)) return undefined;
  if (reason.name === "TimeoutError") return TIMED_OUT_CAUSE;
  if (reason.name === "AbortError") return undefined;
  return reason.message || undefined;
}

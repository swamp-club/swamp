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

import { CLEANUP_GRACE_TIMEOUT_MS } from "../models/cancel_cause.ts";

/**
 * an abort that interrupts a run rather than cancels it: the run will be
 * continued, so no cleanup step starts and unstarted work is left to the resume
 */
export class RunInterruption extends Error {
  constructor(readonly interruptReason: string) {
    super(interruptReason.replaceAll("_", " "));
    this.name = "RunInterruption";
  }
}

export function isInterruption(signal: AbortSignal | undefined): boolean {
  return (signal?.aborted ?? false) &&
    signal?.reason instanceof RunInterruption;
}

/**
 * how long a stopping trigger source waits for its runs: a run a user cancelled
 * before the stop is running its cleanup, so the wait then extends by one
 * cleanup grace, which keeps shutdown bounded
 */
export function stopGraceFor(
  runs: Iterable<{ readonly controller: AbortController }>,
  abortGraceMs: number,
  cleanupGraceMs: number = CLEANUP_GRACE_TIMEOUT_MS,
): number {
  for (const run of runs) {
    if (run.controller.signal.aborted) return cleanupGraceMs + abortGraceMs;
  }
  return abortGraceMs;
}

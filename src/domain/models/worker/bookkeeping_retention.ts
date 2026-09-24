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
 * Retention policy for the serve-side bookkeeping records (see
 * design/enablers/remote-execution.md, "Worker, token and bookkeeping
 * reaping").
 *
 * Step leases and pending dispatches declare `lifetime: "infinite"`, so
 * `swamp data gc` never removes them. A record may be reaped once it has
 * ended — reached a terminal state, after which it is never rewritten — and
 * its `endedAt` is at least the grace period in the past. Live records
 * (active leases, waiting dispatches) are never reapable at any age.
 */

import { StepLeaseSchema, TERMINAL_LEASE_STATES } from "./step_lease_model.ts";
import {
  PendingDispatchSchema,
  TERMINAL_PENDING_DISPATCH_STATES,
} from "./pending_dispatch_model.ts";

function endedLongEnoughAgo(
  endedAt: string | undefined,
  gracePeriodMs: number,
  nowMs: number,
): boolean {
  if (endedAt === undefined) return false;
  const endedMs = Date.parse(endedAt);
  if (Number.isNaN(endedMs)) return false;
  return nowMs - endedMs >= gracePeriodMs;
}

/** True when a step-lease record has ended and aged past the grace period. */
export function isReapableLease(
  attrs: unknown,
  gracePeriodMs: number,
  nowMs: number,
): boolean {
  const parsed = StepLeaseSchema.safeParse(attrs);
  if (!parsed.success) return false;
  if (!TERMINAL_LEASE_STATES.has(parsed.data.state)) return false;
  return endedLongEnoughAgo(parsed.data.endedAt, gracePeriodMs, nowMs);
}

/** True when a pending-dispatch record has ended and aged past the grace period. */
export function isReapableDispatch(
  attrs: unknown,
  gracePeriodMs: number,
  nowMs: number,
): boolean {
  const parsed = PendingDispatchSchema.safeParse(attrs);
  if (!parsed.success) return false;
  if (!TERMINAL_PENDING_DISPATCH_STATES.has(parsed.data.state)) return false;
  return endedLongEnoughAgo(parsed.data.endedAt, gracePeriodMs, nowMs);
}

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
 * step leases and pending dispatches are lifetime infinite, so data gc never
 * removes them; a record is reapable once ended (terminal, never rewritten) and
 * endedAt is past the grace period. Live records never are.
 */

import { minOf } from "../../array_extrema.ts";
import { StepLeaseSchema, TERMINAL_LEASE_STATES } from "./step_lease_model.ts";
import { EnrollmentTokenSchema } from "./enrollment_token_model.ts";
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

function enrollmentTokenEndedMs(
  token: { state: string; expiresAt: string; revokedAt?: string },
  nowMs: number,
): number | undefined {
  const expiresMs = Date.parse(token.expiresAt);
  const revokedMs = token.state === "revoked" && token.revokedAt !== undefined
    ? Date.parse(token.revokedAt)
    : Number.NaN;
  const ends = [expiresMs, revokedMs].filter((ms) =>
    !Number.isNaN(ms) && ms <= nowMs
  );
  if (ends.length === 0) return undefined;
  return minOf(ends);
}

/**
 * True when an enrollment-token record has stopped admitting workers
 * (revoked, or past `expiresAt`) and that happened at least the grace period
 * ago. Whether a worker still references the token is checked by the caller.
 */
export function isReapableEnrollmentToken(
  attrs: unknown,
  gracePeriodMs: number,
  nowMs: number,
): boolean {
  const parsed = EnrollmentTokenSchema.safeParse(attrs);
  if (!parsed.success) return false;
  const endedMs = enrollmentTokenEndedMs(parsed.data, nowMs);
  if (endedMs === undefined) return false;
  return nowMs - endedMs >= gracePeriodMs;
}

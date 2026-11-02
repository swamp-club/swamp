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
 * a deposed leader that writes late lands in its own prefix, which no later
 * leader reads; expiry is recorded as hold remaining plus the leader's time,
 * never a deadline another node's clock judges alone
 */

export const PERSISTED_LEASES_PREFIX = "leases/";

/**
 * The code serve answers a forced release with when the lease ended but its
 * kept record could not be removed: the lease may return at the next
 * leader takeover, and forcing the release again removes the record.
 */
export const LEASE_RECORD_NOT_REMOVED_CODE = "lease_record_not_removed";

export const PERSISTED_LEASES_COMPLETE = "complete";

export interface PersistedLease {
  readonly leaseId: string;
  readonly lockKey: string;
  readonly principal: string;
  readonly fence: number;
  readonly holdMs: number;
  readonly remainingMs: number;
  readonly recordedAt: string;
  readonly leaderFence: number;
  /**
   * Written before the lease is granted and cleared once it is: a record
   * still pending names a lease its leader may have refused (the write
   * landed, its reply did not), so no leader adopts it.
   */
  readonly pending?: true;
}

export function leasePrefixOf(leaderFence: number): string {
  return `${PERSISTED_LEASES_PREFIX}${leaderFence}/`;
}

export function leaderFenceOfKey(key: string): number | undefined {
  if (!key.startsWith(PERSISTED_LEASES_PREFIX)) return undefined;
  const segment = key.slice(PERSISTED_LEASES_PREFIX.length).split("/")[0];
  if (!/^[1-9][0-9]{0,15}$/.test(segment)) return undefined;
  const fence = Number(segment);
  return Number.isSafeInteger(fence) ? fence : undefined;
}

/**
 * When `lease` ends, as a reader's clock judges it: the recording leader's
 * time plus the hold left then, plus `skewMs` in the holder's favour, since
 * the two clocks may differ. A malformed time ends it now.
 */
export function persistedLeaseExpiresAt(
  lease: PersistedLease,
  skewMs: number,
): number {
  const recorded = Date.parse(lease.recordedAt);
  if (Number.isNaN(recorded)) return 0;
  return recorded + lease.remainingMs + skewMs;
}

export function serializePersistedLease(lease: PersistedLease): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    leaseId: lease.leaseId,
    lockKey: lease.lockKey,
    principal: lease.principal,
    fence: lease.fence,
    holdMs: lease.holdMs,
    remainingMs: lease.remainingMs,
    recordedAt: lease.recordedAt,
    leaderFence: lease.leaderFence,
    ...(lease.pending === true ? { pending: true } : {}),
  }));
}

const MAX_FIELD_LENGTH = 1024;

/**
 * Parses a lease record, or returns undefined when it is not one: anyone
 * who can write the control plane can write it, so every field is checked
 * and an unreadable record is skipped, never trusted.
 */
export function parsePersistedLease(
  bytes: Uint8Array,
): PersistedLease | undefined {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return undefined;
  }
  const record = json as Record<string, unknown>;
  const text = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 &&
    value.length <= MAX_FIELD_LENGTH;
  const count = (value: unknown, min: number): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min;
  const {
    leaseId,
    lockKey,
    principal,
    fence,
    holdMs,
    remainingMs,
    recordedAt,
    leaderFence,
    pending,
  } = record;
  if (
    !text(leaseId) || !text(lockKey) || !text(principal) ||
    !count(fence, 1) || !count(holdMs, 1) || !count(remainingMs, 0) ||
    !text(recordedAt) || Number.isNaN(Date.parse(recordedAt)) ||
    !count(leaderFence, 1) || (pending !== undefined && pending !== true)
  ) {
    return undefined;
  }
  return {
    leaseId,
    lockKey,
    principal,
    fence,
    holdMs,
    remainingMs,
    recordedAt,
    leaderFence,
    ...(pending === true ? { pending: true as const } : {}),
  };
}

/**
 * Where serve's leader keeps explicit leases. Every write goes under the
 * caller's own leader prefix; `adopt` is the one read, done once when a
 * leader takes the lead.
 */
export interface PersistedLeaseStore {
  save(leaderFence: number, lease: PersistedLease): Promise<void>;
  remove(leaderFence: number, lockKey: string): Promise<void>;
  /**
   * copies the highest complete prefix under leaderFence, marks it complete,
   * then deletes lower prefixes; pending records are skipped, expired ones
   * returned for the caller to remove; nothing deleted once signal aborts
   */
  adopt(
    leaderFence: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly PersistedLease[]>;
}

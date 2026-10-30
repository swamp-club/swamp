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
 * An explicit lease as serve's leader keeps it in the shared control plane
 * (swamp-club#4195), so a new leader honours it until it expires: a member
 * that checked a lease out to work offline does not lose it to a failover.
 * Only explicit leases (`swamp behavior lease acquire --for`) are kept; a
 * command's short lease still ends at a takeover.
 *
 * Each leader keeps its leases under its own prefix, named by its
 * writer-lease fence ({@link leasePrefixOf}). A leader that was deposed
 * before it noticed writes into its own prefix, which no later leader reads.
 *
 * Expiry is recorded as the hold remaining when the record was written and
 * the recording leader's time, never as a deadline another node's clock
 * judges alone: the reader allows for skew ({@link persistedLeaseExpiresAt}).
 *
 * @module
 */

/** The control-plane prefix every leader's lease records live under. */
export const PERSISTED_LEASES_PREFIX = "leases/";

/**
 * The code serve answers a forced release with when the lease ended but its
 * kept record could not be removed: the lease may return at the next
 * leader takeover, and forcing the release again removes the record.
 */
export const LEASE_RECORD_NOT_REMOVED_CODE = "lease_record_not_removed";

/** The record a leader writes once its prefix holds every adopted lease. */
export const PERSISTED_LEASES_COMPLETE = "complete";

/** An explicit lease, as the leader that granted or adopted it recorded it. */
export interface PersistedLease {
  /** The lease's id, which its holder renews and commits under. */
  readonly leaseId: string;
  /** The canonical lock key it holds, without a namespace. */
  readonly lockKey: string;
  /** Who holds it. */
  readonly principal: string;
  /** Its fence. */
  readonly fence: number;
  /** How long each renewal extends it. */
  readonly holdMs: number;
  /** The hold left when the record was written. */
  readonly remainingMs: number;
  /** When the record was written, by the recording leader's clock (ISO). */
  readonly recordedAt: string;
  /** The writer-lease fence of the leader that wrote the record. */
  readonly leaderFence: number;
  /**
   * Written before the lease is granted and cleared once it is: a record
   * still pending names a lease its leader may have refused (the write
   * landed, its reply did not), so no leader adopts it.
   */
  readonly pending?: true;
}

/** The prefix leader `leaderFence` keeps its lease records under. */
export function leasePrefixOf(leaderFence: number): string {
  return `${PERSISTED_LEASES_PREFIX}${leaderFence}/`;
}

/**
 * The leader fence a control-plane key under {@link PERSISTED_LEASES_PREFIX}
 * belongs to, compared as a number; undefined for any other key.
 */
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

/** Serializes a lease record for the control plane. */
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

/** The longest string field a lease record may hold. */
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
  /** Records `lease` under leader `leaderFence`'s prefix. */
  save(leaderFence: number, lease: PersistedLease): Promise<void>;
  /** Removes `lockKey`'s record from leader `leaderFence`'s prefix. */
  remove(leaderFence: number, lockKey: string): Promise<void>;
  /**
   * Takes over the leases of the leader before `leaderFence`: reads the
   * highest complete prefix at or below it, copies its records under
   * `leaderFence`'s prefix, marks that prefix complete, then deletes every
   * lower prefix. A pending record is neither copied nor returned. Returns
   * what it copied, expired records included: the caller decides which are
   * still live and removes the rest. Once `signal` aborts (a shutdown), it
   * deletes nothing.
   */
  adopt(
    leaderFence: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly PersistedLease[]>;
}

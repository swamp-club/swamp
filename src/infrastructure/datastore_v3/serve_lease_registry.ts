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
 * a lease is held from a fully successful acquire until released or lapsed.
 * This module has no v3 imports, so the lock and the sink can both reach it
 * without an import cycle
 */

import { resolve } from "@std/path";
import type { DataNameMarks } from "../../domain/datastore_v3/commit_store.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";

export interface HeldServeLease {
  readonly leaseId: string;
  readonly fence: number;
  readonly floor: readonly DataNameMarks[];
  /**
   * registered from the checkout's record without serve vouching for it in this
   * process; a commit serve refuses under it is sent again under no lease
   */
  readonly unconfirmed?: true;
}

const held = new Map<string, HeldServeLease>();

function keyOf(root: string, lockKey: string): string {
  return `${resolve(root)}\0${lockKey}`;
}

export function leaseLockKeyOfPartition(
  partition: PartitionKey,
): string | undefined {
  const identity = partition.identity;
  if (identity.kind === "model") {
    return `data/${identity.type}/${identity.id.toLowerCase()}/.lock`;
  }
  if (identity.kind === "run") {
    return `workflow-run-claims/${identity.runId.toLowerCase()}/.lock`;
  }
  return undefined;
}

export interface LandedVersion {
  readonly name: string;
  readonly version: number;
}

/**
 * a fenced lease admits only the holder's own commits, and a caller without
 * `read` never sees them in its copy, so the floor must follow them or the next
 * allocation repeats a version
 */
export function raisedFloor(
  floor: readonly DataNameMarks[],
  landed: readonly LandedVersion[],
): DataNameMarks[] {
  const marks = new Map(floor.map((entry) => [entry.name, entry]));
  for (const { name, version } of landed) {
    const current = marks.get(name);
    if (current === undefined) {
      marks.set(name, { name, highWater: version });
    } else if (version > current.highWater) {
      marks.set(name, { ...current, highWater: version });
    }
  }
  return [...marks.values()];
}

export function raiseServeLeaseFloor(
  root: string,
  partition: PartitionKey,
  leaseId: string,
  landed: readonly LandedVersion[],
): void {
  const lockKey = leaseLockKeyOfPartition(partition);
  if (lockKey === undefined || landed.length === 0) return;
  const key = keyOf(root, lockKey);
  const lease = held.get(key);
  if (lease === undefined || lease.leaseId !== leaseId) return;
  held.set(key, { ...lease, floor: raisedFloor(lease.floor, landed) });
}

export function holdServeLease(
  root: string,
  lockKey: string,
  lease: HeldServeLease,
): void {
  held.set(keyOf(root, lockKey), lease);
}

/**
 * Forgets the lease `leaseId` on `lockKey` for `root`. A later lease on the
 * same key, taken since, is kept.
 */
export function dropServeLease(
  root: string,
  lockKey: string,
  leaseId: string,
): void {
  const key = keyOf(root, lockKey);
  if (held.get(key)?.leaseId === leaseId) held.delete(key);
}

/**
 * forgets the unconfirmed lease once serve refused a commit under it; a lease
 * confirmed since, or another taken since, is kept
 */
export function dropUnconfirmedServeLease(
  root: string,
  partition: PartitionKey,
  leaseId: string,
): void {
  const lockKey = leaseLockKeyOfPartition(partition);
  if (lockKey === undefined) return;
  const key = keyOf(root, lockKey);
  const lease = held.get(key);
  if (lease?.leaseId === leaseId && lease.unconfirmed === true) {
    held.delete(key);
  }
}

export function heldServeLeaseOf(
  root: string,
  partition: PartitionKey,
): HeldServeLease | undefined {
  const lockKey = leaseLockKeyOfPartition(partition);
  return lockKey === undefined ? undefined : held.get(keyOf(root, lockKey));
}

interface ReleasableLease {
  readonly quiet: () => Promise<void>;
  readonly resume: () => void;
  released: boolean;
}

/** a command's own leases, by id, which the commit that ends the hold may end */
const releasable = new Map<string, ReleasableLease>();

/**
 * offered by a command's own hold; `quiet` stops its renewals, so a renewal
 * after serve ended the lease is never read as a lapse
 */
export function offerServeLeaseRelease(
  leaseId: string,
  quiet: () => Promise<void>,
  resume: () => void,
): void {
  releasable.set(leaseId, { quiet, resume, released: false });
}

/** renews the quieted hold again: serve did not end the lease after all */
export function resumeServeLease(leaseId: string): void {
  const lease = releasable.get(leaseId);
  if (lease !== undefined && !lease.released) lease.resume();
}

export function withdrawServeLeaseRelease(leaseId: string): void {
  releasable.delete(leaseId);
}

/**
 * quiets the hold before a commit asks serve to end its lease; false when the
 * lease is not a command's own hold here, which is never ended by a commit
 */
export async function quietServeLeaseForRelease(
  leaseId: string,
): Promise<boolean> {
  const lease = releasable.get(leaseId);
  if (lease === undefined) return false;
  await lease.quiet();
  return true;
}

export function noteServeLeaseReleased(leaseId: string): void {
  const lease = releasable.get(leaseId);
  if (lease !== undefined) lease.released = true;
}

/** serve ended the lease with the commit that closed the hold */
export function serveLeaseReleasedByCommit(leaseId: string): boolean {
  return releasable.get(leaseId)?.released === true;
}

export function resetServeLeasesForTesting(): void {
  held.clear();
  releasable.clear();
}

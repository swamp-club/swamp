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
 * The fenced model leases this process holds at serve (swamp-club#4121), by
 * checkout root and serve's canonical lock key. A lease is held from the
 * moment its acquire fully succeeded until it is released or lapses. The
 * serve sink names a held lease on each commit to the partition it covers,
 * and a unit allocates data versions above its floor.
 *
 * A module of its own with no v3 imports, as `serve_upstream_registry.ts`
 * is, so the lock and the sink can both reach it without an import cycle.
 *
 * @module
 */

import { resolve } from "@std/path";
import type { DataNameMarks } from "../../domain/datastore_v3/commit_store.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";

/** A fenced lease this process holds. */
export interface HeldServeLease {
  readonly leaseId: string;
  readonly fence: number;
  /** Each data name's version marks when the lease was taken. */
  readonly floor: readonly DataNameMarks[];
}

const held = new Map<string, HeldServeLease>();

function keyOf(root: string, lockKey: string): string {
  return `${resolve(root)}\0${lockKey}`;
}

/**
 * Serve's canonical lock key for the lease that covers `partition`, as
 * serve derives it: a behavior's partition is covered by its model lock, a
 * run's by its claim. Undefined for any other partition.
 */
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

/** Records that this process holds `lease` on `lockKey` for `root`. */
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

/** The fenced lease this process holds on `partition` for `root`, if any. */
export function heldServeLeaseOf(
  root: string,
  partition: PartitionKey,
): HeldServeLease | undefined {
  const lockKey = leaseLockKeyOfPartition(partition);
  return lockKey === undefined ? undefined : held.get(keyOf(root, lockKey));
}

/** Test seam: forgets every lease this process holds. */
export function resetServeLeasesForTesting(): void {
  held.clear();
}

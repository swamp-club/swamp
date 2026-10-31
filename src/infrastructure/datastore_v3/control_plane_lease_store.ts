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
 * Serve's explicit leases in its shared control plane (swamp-club#4195):
 * `leases/<leaderFence>/<sha256 of the lock key>`, with a
 * `leases/<leaderFence>/complete` record once a leader's prefix holds every
 * lease it adopted. See {@link PersistedLeaseStore}.
 *
 * @module
 */

import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import {
  leaderFenceOfKey,
  leasePrefixOf,
  parsePersistedLease,
  PERSISTED_LEASES_COMPLETE,
  PERSISTED_LEASES_PREFIX,
  type PersistedLease,
  type PersistedLeaseStore,
  serializePersistedLease,
} from "../../domain/datastore_v3/persisted_lease.ts";
import { getSwampLogger } from "../logging/logger.ts";

const logger = getSwampLogger(["serve", "datastore-locks"]);

/** The control-plane key of `lockKey`'s record under a leader's prefix. */
async function recordKeyOf(
  leaderFence: number,
  lockKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(lockKey),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${leasePrefixOf(leaderFence)}${hex}`;
}

/** The record marking a leader's prefix complete. */
function completeKeyOf(leaderFence: number): string {
  return `${leasePrefixOf(leaderFence)}${PERSISTED_LEASES_COMPLETE}`;
}

/** A {@link PersistedLeaseStore} over serve's control-plane store. */
export class ControlPlaneLeaseStore implements PersistedLeaseStore {
  readonly #store: ControlPlaneStore;

  constructor(store: ControlPlaneStore) {
    this.#store = store;
  }

  async save(leaderFence: number, lease: PersistedLease): Promise<void> {
    await this.#store.put(
      await recordKeyOf(leaderFence, lease.lockKey),
      serializePersistedLease(lease),
    );
  }

  async remove(leaderFence: number, lockKey: string): Promise<void> {
    await this.#store.delete(await recordKeyOf(leaderFence, lockKey));
  }

  async adopt(
    leaderFence: number,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly PersistedLease[]> {
    const stopped = () => options.signal?.aborted === true;
    const byFence = new Map<number, string[]>();
    for (const key of await this.#store.list(PERSISTED_LEASES_PREFIX)) {
      const fence = leaderFenceOfKey(key);
      if (fence === undefined) continue;
      const keys = byFence.get(fence) ?? [];
      keys.push(key);
      byFence.set(fence, keys);
    }
    // The newest prefix its leader finished, at or below this leader's
    // own: an unfinished prefix is a leader that never served, and a higher
    // one a leader after this one, whose records are not this one's to read.
    let source: number | undefined;
    for (const [fence, keys] of byFence) {
      if (fence > leaderFence) continue;
      if (!keys.includes(completeKeyOf(fence))) continue;
      if (source === undefined || fence > source) source = fence;
    }
    const leases: PersistedLease[] = [];
    // Records of leases their leader never granted, in this leader's own
    // prefix: a restart at the same fence finds them there.
    const pending: string[] = [];
    if (source !== undefined) {
      for (const key of byFence.get(source) ?? []) {
        if (key === completeKeyOf(source)) continue;
        const bytes = await this.#store.get(key);
        const lease = bytes === null ? undefined : parsePersistedLease(bytes);
        if (lease === undefined) {
          logger.warn`Skipping an unreadable lease record at ${key}`;
          continue;
        }
        if (await recordKeyOf(source, lease.lockKey) !== key) {
          logger
            .warn`Skipping a lease record at ${key} filed under another key`;
          continue;
        }
        if (lease.pending === true) {
          if (source === leaderFence) pending.push(key);
          continue;
        }
        leases.push(lease);
      }
    }
    if (source !== leaderFence) {
      // Copied, then marked complete, then the older prefixes go: a crash
      // before the mark leaves a prefix the next leader skips for the
      // complete one below it.
      for (const lease of leases) {
        // A shutdown writes nothing more: without this prefix's mark, the
        // next leader reads the complete one it was copying from.
        if (stopped()) return [];
        await this.save(leaderFence, { ...lease, leaderFence });
      }
      if (stopped()) return [];
      await this.#store.put(
        completeKeyOf(leaderFence),
        new TextEncoder().encode(new Date().toISOString()),
      );
    }
    for (const key of pending) {
      if (stopped()) break;
      await this.#store.delete(key);
    }
    for (const [fence, keys] of byFence) {
      if (fence >= leaderFence) continue;
      if (stopped()) break;
      // Its mark first: a record a deposed leader writes late lands in a
      // prefix with no mark, which no leader reads.
      const complete = completeKeyOf(fence);
      if (keys.includes(complete)) await this.#store.delete(complete);
      for (const key of keys) {
        if (stopped()) break;
        if (key !== complete) await this.#store.delete(key);
      }
    }
    return leases.map((lease) => ({ ...lease, leaderFence }));
  }
}

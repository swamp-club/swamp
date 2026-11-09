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

import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import {
  DEFAULT_STALE_TTL_MS,
  InstanceHeartbeatService,
} from "./instance_heartbeat.ts";

// 2: refresh keeps the refresh token, so no node may still rotate and end a
// link on a racing refresh
export const DELEGATION_LINKS_CAPABILITY = "delegation-links-2";

export type DelegationCapability =
  | { readonly ok: true }
  | { readonly ok: false; readonly instances: readonly string[] };

/**
 * every live node must honour delegated tokens before one is issued; a stale or
 * stopped heartbeat is not live, and a record this build can't parse is a node
 * it knows nothing about, so it counts against
 */
export async function checkDelegationCapability(
  store: ControlPlaneStore | undefined,
  options: { staleTtlMs?: number } = {},
): Promise<DelegationCapability> {
  if (store === undefined) return { ok: true };
  const lacking: string[] = [];
  for (const key of await store.list("heartbeats/")) {
    const data = await store.get(key);
    if (data === null) continue;
    const record = InstanceHeartbeatService.parseRecord(data);
    if (record === null) {
      lacking.push(key.slice("heartbeats/".length));
      continue;
    }
    const ttl = record.staleTtlMs ?? options.staleTtlMs ??
      DEFAULT_STALE_TTL_MS;
    if (InstanceHeartbeatService.isStale(record, ttl)) continue;
    if (!record.capabilities?.includes(DELEGATION_LINKS_CAPABILITY)) {
      lacking.push(`${record.instanceId} (${record.hostname})`);
    }
  }
  return lacking.length === 0
    ? { ok: true }
    : { ok: false, instances: lacking };
}

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

import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import type { FingerprintProps } from "../../domain/serve/fingerprint.ts";
import {
  DEFAULT_STALE_TTL_MS,
  InstanceHeartbeatService,
} from "../instance_heartbeat.ts";

export interface HubTeamFactsOptions {
  /** true only on a v3 team; every other mode is reported as a single node */
  readonly teamMode: boolean;
  readonly following: () => boolean;
  /** where the team's nodes beat; absent, the count is this node alone */
  readonly heartbeats?: ControlPlaneStore;
  readonly staleTtlMs?: number;
  readonly now?: () => number;
}

/** counts the nodes cluster.instances would call healthy or degraded */
export async function hubTeamFacts(
  options: HubTeamFactsOptions,
): Promise<FingerprintProps["team"]> {
  if (!options.teamMode) return { role: "single", nodes: 1 };
  const role = options.following() ? "follower" : "leader";
  if (options.heartbeats === undefined) return { role, nodes: 1 };
  const now = (options.now ?? Date.now)();
  const staleTtlMs = options.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
  let nodes = 0;
  for (const key of await options.heartbeats.list("heartbeats/")) {
    const data = await options.heartbeats.get(key);
    if (data === null) continue;
    const record = InstanceHeartbeatService.parseRecord(data);
    if (record === null || InstanceHeartbeatService.isStopped(record)) continue;
    const age = now - new Date(record.heartbeatAt).getTime();
    if (age <= staleTtlMs) nodes++;
  }
  return { role, nodes: Math.max(1, nodes) };
}

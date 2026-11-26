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

/**
 * v3: a team with a leader; v2-shared: v2 serves sharing a remote control
 * plane, peers with no leader; local: a control plane only this serve reads
 */
export type ServeTeamMode = "v3" | "v2-shared" | "local";

export interface ServeTeamFactsOptions {
  readonly mode: ServeTeamMode;
  readonly following: () => boolean;
  /** where the team's nodes beat; absent, the count is this node alone */
  readonly heartbeats?: ControlPlaneStore;
  readonly staleTtlMs?: number;
  readonly now?: () => number;
}

export function serveTeamMode(options: {
  readonly v3: boolean;
  readonly hasRemoteControlPlane: boolean;
}): ServeTeamMode {
  if (options.v3) return "v3";
  return options.hasRemoteControlPlane ? "v2-shared" : "local";
}

/** this node's place in its team, shared by a hub and a member */
export async function serveTeamFacts(
  options: ServeTeamFactsOptions,
): Promise<FingerprintProps["team"]> {
  if (options.mode === "local") return { role: "single", nodes: 1 };
  const nodes = await liveNodes(options);
  if (options.mode === "v2-shared") {
    // one live v2 node is a serve on its own, whatever store it uses
    return nodes >= 2 ? { role: "peer", nodes } : { role: "single", nodes: 1 };
  }
  return { role: options.following() ? "follower" : "leader", nodes };
}

// counts the nodes cluster.instances would call healthy or degraded
async function liveNodes(options: ServeTeamFactsOptions): Promise<number> {
  if (options.heartbeats === undefined) return 1;
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
  return Math.max(1, nodes);
}

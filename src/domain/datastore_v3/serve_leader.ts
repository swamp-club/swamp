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
 * Serve's leader in team mode (swamp-club#4096). Every serve node behind one
 * address shares a v3 datastore; the node holding the datastore's writer
 * lease leads and writes, and the others follow: they serve reads from
 * their own copy and refuse writes. The lease and its fence alone decide
 * who may commit. The leader record only names the leader to followers, so
 * a stale record can name the wrong node but never lets a follower write.
 *
 * @module
 */

import { UserError } from "../errors.ts";

/** Error code for a write that reached a serve node that does not lead. */
export const SERVE_NOT_LEADER_CODE = "serve_not_leader";

/** The control-plane key the leader's record lives at. */
export const SERVE_LEADER_KEY = "leader/current";

/** Which serve node leads, as the leader recorded it. */
export interface ServeLeader {
  /** The leading serve instance. */
  readonly instanceId: string;
  /** The writer-lease fence it leads at. */
  readonly fence: number;
  /** Its own address (`scheme://host:port`), when it published one. */
  readonly address?: string;
  /** When it took the lead, as an ISO 8601 timestamp. */
  readonly since: string;
}

/** Serializes a leader record for the control plane. */
export function serializeServeLeader(leader: ServeLeader): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    instanceId: leader.instanceId,
    fence: leader.fence,
    ...(leader.address !== undefined ? { address: leader.address } : {}),
    since: leader.since,
  }));
}

/**
 * Parses a leader record, or returns undefined when it is not one: an
 * unreadable record names no leader rather than failing a refusal.
 */
export function parseServeLeader(data: Uint8Array): ServeLeader | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.instanceId !== "string" || record.instanceId === "" ||
    !Number.isSafeInteger(record.fence) || (record.fence as number) < 1 ||
    typeof record.since !== "string" ||
    Number.isNaN(Date.parse(record.since)) ||
    (record.address !== undefined && typeof record.address !== "string")
  ) {
    return undefined;
  }
  return {
    instanceId: record.instanceId,
    fence: record.fence as number,
    ...(record.address !== undefined
      ? { address: record.address as string }
      : {}),
    since: record.since,
  };
}

/**
 * A write refused by a serve node that does not lead the datastore: retry
 * it, at the leader when it is named. Forwarding the write to the leader is
 * a later step of team mode (p5-feed); until then the client retries.
 */
export class ServeNotLeaderError extends UserError {
  declare readonly code: typeof SERVE_NOT_LEADER_CODE;

  constructor(
    readonly leader: ServeLeader | undefined,
    readonly reads = false,
  ) {
    super(
      (reads
        ? "This swamp serve node does not lead the datastore and its copy " +
          "is behind, so it did not answer. "
        : "This swamp serve node does not lead the datastore, so it did " +
          "not take the request. ") +
        (leader === undefined
          ? "The leader is not known yet; try again shortly."
          : `The leader is serve instance ${leader.instanceId}` +
            (leader.address !== undefined ? ` at ${leader.address}` : "") +
            "; try again there, or here shortly.") +
        " Nothing was changed.",
      SERVE_NOT_LEADER_CODE,
    );
    this.name = "ServeNotLeaderError";
  }
}

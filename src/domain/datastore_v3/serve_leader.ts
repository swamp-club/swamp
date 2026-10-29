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
 * their own copy and forward writes to the leader (swamp-club#4120), or
 * refuse them when no leader can be reached. The lease and its fence alone decide
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
  /**
   * The team's proof that a leader wrote this record (swamp-club#4120): a
   * follower forwards callers' credentials to `address` only when it holds,
   * so whoever can write the shared control plane cannot redirect them.
   */
  readonly proof?: string;
}

/** What a leader record's proof covers. */
export function serveLeaderProofText(leader: ServeLeader): string {
  return [
    leader.instanceId,
    String(leader.fence),
    leader.address ?? "",
    leader.since,
  ].join("\n");
}

/** Serializes a leader record for the control plane. */
export function serializeServeLeader(leader: ServeLeader): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    instanceId: leader.instanceId,
    fence: leader.fence,
    ...(leader.address !== undefined ? { address: leader.address } : {}),
    since: leader.since,
    ...(leader.proof !== undefined ? { proof: leader.proof } : {}),
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
    (record.address !== undefined && typeof record.address !== "string") ||
    (record.proof !== undefined && typeof record.proof !== "string")
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
    ...(record.proof !== undefined ? { proof: record.proof as string } : {}),
  };
}

/**
 * Normalizes `--advertise-address`: this node's own address as its team's
 * other nodes reach it, which the leader record names so followers can
 * forward to it (swamp-club#4120). It is an http(s) origin with no path,
 * query or credentials; a wildcard host names no node and is refused. An
 * explicit loopback address is accepted, for a team on one host.
 */
export function normalizeAdvertiseAddress(address: string): string {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new UserError(advertiseAddressMessage);
  }
  const bare = parsed.hostname.replace(/^\[|\]$/g, "");
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" || parsed.password !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search !== "" || parsed.hash !== "" ||
    bare === "0.0.0.0" || /^(0*:)+0*$/.test(bare) || bare === "::"
  ) {
    throw new UserError(advertiseAddressMessage);
  }
  return parsed.origin;
}

const advertiseAddressMessage =
  "The advertise address must be this node's own http(s) origin, as the " +
  "team's other serve nodes reach it, e.g. https://node-1.internal:9090: no " +
  "path, query, credentials or wildcard host";

/**
 * A write a serve node that does not lead the datastore could not take or
 * pass on: retry it, at the leader when it is named. A follower forwards
 * writes to the leader (swamp-club#4120) and refuses only when no leader can
 * be reached. When the leader changed or stopped answering after a forwarded
 * request reached it, the refusal is `inFlight`: the request may already
 * have run, so the follower never retries it and the caller checks first.
 */
export class ServeNotLeaderError extends UserError {
  declare readonly code: typeof SERVE_NOT_LEADER_CODE;

  constructor(
    readonly leader: ServeLeader | undefined,
    readonly reads = false,
    readonly inFlight = false,
  ) {
    super(
      inFlight
        ? "This swamp serve node forwarded the request to the leader, which " +
          "changed or stopped answering before it replied. The request may " +
          "already have run: check its outcome before retrying."
        : (reads
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

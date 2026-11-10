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
 * the lease and its fence alone decide who may commit; the leader record only
 * names the leader, so a stale record can name the wrong node but never lets a
 * follower write
 */

import { UserError } from "../errors.ts";

export const SERVE_NOT_LEADER_CODE = "serve_not_leader";

export const SERVE_FOLLOWER_BEHIND_CODE = "serve_follower_behind";

export const SERVE_LEADER_KEY = "leader/current";

export interface ServeLeader {
  readonly instanceId: string;
  readonly fence: number;
  readonly address?: string;
  readonly since: string;
  /**
   * a follower forwards callers' credentials to address only when the proof
   * holds, so whoever can write the shared control plane cannot redirect them
   */
  readonly proof?: string;
}

export function serveLeaderProofText(leader: ServeLeader): string {
  return [
    leader.instanceId,
    String(leader.fence),
    leader.address ?? "",
    leader.since,
  ].join("\n");
}

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
 * a wildcard host names no node and is refused; an explicit loopback address is
 * accepted, for a team on one host
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

/**
 * plain http to a non-loopback host would carry the team's peer key and
 * forwarded credentials across a network unencrypted
 */
export function advertiseAddressInCleartext(address: string): boolean {
  const url = new URL(address);
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // the URL parser writes an IPv4-mapped address in hex, so 127.0.0.1 mapped is
  // ::ffff:7f00:1
  return !(host === "localhost" || host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host));
}

const advertiseAddressMessage =
  "The advertise address must be this node's own http(s) origin, as the " +
  "team's other serve nodes reach it, e.g. https://node-1.internal:9090: no " +
  "path, query, credentials or wildcard host";

/**
 * when a forwarded request may already have run, the refusal is inFlight: the
 * follower never retries it and the caller checks first
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

/**
 * the follower is catching up (as after a restart), so a retry shortly is
 * answered; never a sign of divergence, and nothing was changed
 */
export class ServeFollowerBehindError extends UserError {
  declare readonly code: typeof SERVE_FOLLOWER_BEHIND_CODE;

  constructor() {
    super(
      "This swamp serve node's copy of the datastore is behind this " +
        "checkout's copy: it is still catching up with the leader, so it " +
        "did not answer. Try again shortly. Nothing was changed.",
      SERVE_FOLLOWER_BEHIND_CODE,
    );
    this.name = "ServeFollowerBehindError";
  }
}

/** a refusal that changed nothing and that serve answers once it leads again */
export function retryableServeRefusal(
  error: unknown,
): ServeNotLeaderError | ServeFollowerBehindError | undefined {
  if (error instanceof ServeFollowerBehindError) return error;
  if (error instanceof ServeNotLeaderError && !error.inFlight) return error;
  return undefined;
}

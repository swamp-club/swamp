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

import {
  notPlainUsernameReason,
  resolvedCacheKey,
  unresolvedCacheKey,
  usernameOf,
  type UsernameResolver,
} from "./oauth_access_list_resolution.ts";
import { UsernameNotFoundError } from "./oauth_client.ts";

/**
 * Stands in for an allowed-users list that removals and deferred names left
 * empty, so admission stays closed: no subject or principal id contains NUL.
 */
export const CLOSED_ALLOWED_USERS_ENTRY = "\u0000no-user-admitted";

export interface AllowedUsersReloadInput {
  /** the names in the reloaded serve.yaml */
  readonly configured: readonly string[];
  readonly allowedCollectives: readonly string[];
  /** the stored name map: admin and allowed-user records and markers */
  readonly cache: Readonly<Record<string, string>>;
  /** null without a club API key: new names then wait for a restart */
  readonly resolve: UsernameResolver | null;
  readonly now: () => string;
}

export interface SkippedName {
  readonly name: string;
  readonly reason: string;
}

export interface AllowedUsersReloadPlan {
  /** what the live list becomes */
  readonly allowedUsers: readonly string[];
  /** the configured names that are admitted, for the config views */
  readonly namesInForce: readonly string[];
  readonly usernamesBySub: Readonly<Record<string, string>>;
  /** names that could not be looked up now; retried on the next reload */
  readonly deferred: readonly SkippedName[];
  /** names that will never match: not on the provider, or not a username */
  readonly skipped: readonly SkippedName[];
  readonly cache: Readonly<Record<string, string>>;
  readonly cacheChanged: boolean;
  readonly closed: boolean;
}

function own(
  cache: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(cache, key) ? cache[key] : undefined;
}

const ALLOWED_PREFIX = resolvedCacheKey("allowed-user", "");
const UNRESOLVED_ALLOWED_PREFIX = unresolvedCacheKey("allowed-user", "");

/**
 * The allowed-users list a reload puts in force. Removals always apply; a new
 * name that cannot be looked up now waits without a not-found marker, so the
 * next reload retries it; one name's lookup error never refuses the file. A
 * name the provider does not have is marked and stays skipped, as at startup.
 */
export async function planAllowedUsersReload(
  input: AllowedUsersReloadInput,
): Promise<AllowedUsersReloadPlan> {
  const configuredNames = new Set(input.configured.map(usernameOf));
  // the map follows the file: a removed name's records go, admin records stay
  const cache: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(input.cache)) {
    const name = key.startsWith(UNRESOLVED_ALLOWED_PREFIX)
      ? key.slice(UNRESOLVED_ALLOWED_PREFIX.length)
      : key.startsWith(ALLOWED_PREFIX)
      ? key.slice(ALLOWED_PREFIX.length)
      : undefined;
    if (name === undefined || configuredNames.has(name)) cache[key] = value;
  }

  const allowedUsers: string[] = [];
  const namesInForce: string[] = [];
  const usernamesBySub: Record<string, string> = Object.create(null);
  const deferred: SkippedName[] = [];
  const skipped: SkippedName[] = [];
  for (const entry of input.configured) {
    const name = usernameOf(entry);
    const notPlain = notPlainUsernameReason(name);
    if (notPlain !== undefined) {
      skipped.push({ name: entry, reason: notPlain });
      continue;
    }
    const sub = own(cache, resolvedCacheKey("allowed-user", name));
    if (sub !== undefined) {
      allowedUsers.push(sub);
      namesInForce.push(entry);
      usernamesBySub[sub] = name;
      continue;
    }
    const markerKey = unresolvedCacheKey("allowed-user", name);
    const notFoundSince = own(cache, markerKey);
    if (notFoundSince !== undefined) {
      skipped.push({ name: entry, reason: `not found since ${notFoundSince}` });
      continue;
    }
    if (input.resolve === null) {
      deferred.push({
        name: entry,
        reason:
          "not looked up yet and serve has no club API key; set SWAMP_API_KEY or --club-api-key-file, or restart serve",
      });
      continue;
    }
    try {
      const resolved = await input.resolve(name);
      cache[resolvedCacheKey("allowed-user", name)] = resolved;
      allowedUsers.push(resolved);
      namesInForce.push(entry);
      usernamesBySub[resolved] = name;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof UsernameNotFoundError) {
        cache[markerKey] = input.now();
        skipped.push({ name: entry, reason: message });
      } else {
        deferred.push({ name: entry, reason: `lookup failed: ${message}` });
      }
    }
  }

  const closed = allowedUsers.length === 0 && input.configured.length > 0 &&
    input.allowedCollectives.length === 0;
  return {
    allowedUsers: closed ? [CLOSED_ALLOWED_USERS_ENTRY] : allowedUsers,
    namesInForce,
    usernamesBySub,
    deferred,
    skipped,
    cache,
    cacheChanged: !sameEntries(input.cache, cache),
    closed,
  };
}

function sameEntries(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

/** the reason a partly applied allowed-users list reports, or none */
export function allowedUsersPartialReason(
  plan: AllowedUsersReloadPlan,
): string | undefined {
  const parts: string[] = [];
  if (plan.deferred.length > 0) {
    parts.push(
      `${plan.deferred.map((d) => d.name).join(", ")} not admitted yet (${
        plan.deferred[0].reason
      })`,
    );
  }
  if (plan.skipped.length > 0) {
    parts.push(
      `${plan.skipped.map((s) => s.name).join(", ")} skipped (${
        plan.skipped[0].reason
      })`,
    );
  }
  if (plan.closed) {
    parts.push("no listed user is admitted, so admission stays closed");
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

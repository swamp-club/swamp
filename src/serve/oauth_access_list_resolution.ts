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
 * Resolves the usernames in `auth.admins` and `auth.allowed-users` to OAuth
 * subjects at `swamp serve` startup.
 *
 * Results are cached in the `oauth-resolved-admins` vault entry as a flat
 * map. Resolved names map to their sub (`<name>` for admins,
 * `allowed:<name>` for allowed-users). A name the provider reported as not
 * found maps to the time it was first seen missing (`unresolved:<name>`,
 * `unresolved:allowed:<name>`).
 *
 * A name is only ever skipped on a definitive not-found. Any other lookup
 * failure aborts startup in full mode, because dropping an existing admin
 * from the list makes `materializeAdmins` revoke their grant.
 */

import { UserError } from "../domain/errors.ts";
import { UsernameNotFoundError } from "./oauth_client.ts";

/** Which access list an entry came from. */
export type AccessListKind = "admin" | "allowed-user";

/**
 * How startup resolves the lists:
 * - `full`: some name is not in the cache at all. Every name is looked up.
 * - `retry`: every name is cached, some as not-found, and a non-interactive
 *   token is available. Only the not-found names are looked up again.
 * - `cached`: every name is cached. No lookups.
 */
export type ResolutionMode = "full" | "retry" | "cached";

/** Looks up one username on the provider and returns its sub. */
export type UsernameResolver = (username: string) => Promise<string>;

/** A configured entry that could not be resolved and was left out. */
export interface UnresolvedEntry {
  readonly kind: AccessListKind;
  /** The entry exactly as configured, e.g. `user:alice`. */
  readonly entry: string;
  readonly username: string;
  /** When the provider first reported the name as not found. */
  readonly notFoundSince: string;
  /** Why the latest lookup failed; absent when the cache was used. */
  readonly reason?: string;
}

/** A configured entry that resolved to a sub. */
export interface ResolvedEntry {
  readonly kind: AccessListKind;
  readonly entry: string;
  readonly username: string;
  readonly sub: string;
  /** True when the sub came from the cache rather than a lookup. */
  readonly fromCache: boolean;
}

export interface AccessListResolution {
  /** Resolved admins as `user:<sub>`, in configured order. */
  readonly admins: string[];
  /** Resolved allowed-users as `<sub>`, in configured order. */
  readonly allowedUsers: string[];
  /** Resolved sub → configured username, for display. */
  readonly usernamesBySub: Record<string, string>;
  /** The cache map to persist for the configured names. */
  readonly cache: Record<string, string>;
  /** True when {@link cache} differs from the cache passed in. */
  readonly cacheChanged: boolean;
  readonly resolved: ResolvedEntry[];
  readonly unresolved: UnresolvedEntry[];
}

export interface ResolveAccessListsInput {
  readonly admins: readonly string[];
  readonly allowedUsers: readonly string[];
  readonly cache: Readonly<Record<string, string>>;
  readonly mode: ResolutionMode;
  /** Required unless `mode` is `cached`. */
  readonly resolve: UsernameResolver | null;
  readonly providerUrl: string;
  /** Current time as an ISO string; injected for tests. */
  readonly now: () => string;
}

/** Strips the optional `user:` prefix from a configured entry. */
export function usernameOf(entry: string): string {
  return entry.startsWith("user:") ? entry.slice("user:".length) : entry;
}

/** Cache key holding the sub of a resolved name. */
export function resolvedCacheKey(
  kind: AccessListKind,
  username: string,
): string {
  return kind === "admin" ? username : `allowed:${username}`;
}

/** Cache key marking a name the provider reported as not found. */
export function unresolvedCacheKey(
  kind: AccessListKind,
  username: string,
): string {
  return `unresolved:${resolvedCacheKey(kind, username)}`;
}

interface ConfiguredEntry {
  readonly kind: AccessListKind;
  readonly entry: string;
  readonly username: string;
}

function configuredEntries(
  admins: readonly string[],
  allowedUsers: readonly string[],
): ConfiguredEntry[] {
  return [
    ...admins.map((entry) => ({
      kind: "admin" as const,
      entry,
      username: usernameOf(entry),
    })),
    ...allowedUsers.map((entry) => ({
      kind: "allowed-user" as const,
      entry,
      username: usernameOf(entry),
    })),
  ];
}

/**
 * Configured names with neither a resolved entry nor a not-found marker in
 * the cache, formatted as `<name>` for admins and `allowed:<name>` for
 * allowed-users.
 */
export function listUncachedNames(
  admins: readonly string[],
  allowedUsers: readonly string[],
  cache: Readonly<Record<string, string>>,
): string[] {
  return configuredEntries(admins, allowedUsers)
    .filter(({ kind, username }) =>
      !cache[resolvedCacheKey(kind, username)] &&
      !cache[unresolvedCacheKey(kind, username)]
    )
    .map(({ kind, username }) => resolvedCacheKey(kind, username));
}

/** Picks the resolution mode for the configured lists and cache. */
export function chooseResolutionMode(
  admins: readonly string[],
  allowedUsers: readonly string[],
  cache: Readonly<Record<string, string>>,
  retryUnresolved: boolean,
): ResolutionMode {
  if (listUncachedNames(admins, allowedUsers, cache).length > 0) {
    return "full";
  }
  const hasUnresolved = configuredEntries(admins, allowedUsers).some((
    { kind, username },
  ) => !cache[resolvedCacheKey(kind, username)]);
  return hasUnresolved && retryUnresolved ? "retry" : "cached";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolves the configured lists according to `mode`. Throws a `UserError`
 * when a full-mode lookup fails for any reason other than not-found.
 * Callers must run {@link assertAccessListsUsable} on the result before
 * persisting the cache or acting on the lists.
 */
export async function resolveAccessLists(
  input: ResolveAccessListsInput,
): Promise<AccessListResolution> {
  const { cache, mode, resolve, providerUrl, now } = input;
  if (mode !== "cached" && !resolve) {
    throw new Error(`A resolver is required in ${mode} mode`);
  }

  const admins: string[] = [];
  const allowedUsers: string[] = [];
  const usernamesBySub: Record<string, string> = {};
  const nextCache: Record<string, string> = {};
  const resolved: ResolvedEntry[] = [];
  const unresolved: UnresolvedEntry[] = [];

  const accept = (entry: ConfiguredEntry, sub: string, fromCache: boolean) => {
    nextCache[resolvedCacheKey(entry.kind, entry.username)] = sub;
    resolved.push({ ...entry, sub, fromCache });
    usernamesBySub[sub] = entry.username;
    if (entry.kind === "admin") {
      admins.push(`user:${sub}`);
    } else {
      allowedUsers.push(sub);
    }
  };

  const skip = (entry: ConfiguredEntry, reason?: string) => {
    const markerKey = unresolvedCacheKey(entry.kind, entry.username);
    const notFoundSince = cache[markerKey] ?? nextCache[markerKey] ?? now();
    nextCache[markerKey] = notFoundSince;
    unresolved.push({
      kind: entry.kind,
      entry: entry.entry,
      username: entry.username,
      notFoundSince,
      ...(reason !== undefined ? { reason } : {}),
    });
  };

  for (const entry of configuredEntries(input.admins, input.allowedUsers)) {
    const cachedSub = cache[resolvedCacheKey(entry.kind, entry.username)];

    if (mode === "cached" || (mode === "retry" && cachedSub)) {
      if (cachedSub) {
        accept(entry, cachedSub, true);
      } else {
        skip(entry);
      }
      continue;
    }

    try {
      accept(entry, await resolve!(entry.username), false);
    } catch (err) {
      if (err instanceof UsernameNotFoundError || mode === "retry") {
        // In retry mode only not-found names are looked up. They hold no
        // grant, so a transient failure can safely leave them skipped.
        skip(entry, errorMessage(err));
        continue;
      }
      const label = entry.kind === "admin" ? "admin" : "allowed-user";
      throw new UserError(
        `Failed to resolve ${label} '${entry.entry}': ${
          errorMessage(err)
        }. Ensure the username exists on ${providerUrl}.`,
      );
    }
  }

  return {
    admins,
    allowedUsers,
    usernamesBySub,
    cache: nextCache,
    cacheChanged: !sameEntries(cache, nextCache),
    resolved,
    unresolved,
  };
}

function sameEntries(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length &&
    aKeys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

function quotedEntries(
  unresolved: readonly UnresolvedEntry[],
  kind: AccessListKind,
): string {
  return unresolved
    .filter((u) => u.kind === kind)
    .map((u) => `'${u.entry}'`)
    .join(", ");
}

/**
 * Fails closed when skipping names would break the OAuth-mode invariants
 * that `parseServeAuthConfig` enforces on the raw config: there must be at
 * least one admin, and admission must stay restricted. `checkAdmission`
 * admits every user when both allowed-users and allowed-collectives are
 * empty, so losing every allowed-user with no collectives must not start.
 */
export function assertAccessListsUsable(
  configured: {
    readonly admins: readonly string[];
    readonly allowedUsers: readonly string[];
    readonly allowedCollectives: readonly string[];
  },
  resolution: AccessListResolution,
  providerUrl: string,
): void {
  if (configured.admins.length > 0 && resolution.admins.length === 0) {
    throw new UserError(
      `Failed to resolve admin ${
        quotedEntries(resolution.unresolved, "admin")
      }: none of the configured admins exist on ${providerUrl}. ` +
        "Serve will not start without an admin. Fix the names in auth.admins.",
    );
  }
  if (
    configured.allowedUsers.length > 0 &&
    resolution.allowedUsers.length === 0 &&
    configured.allowedCollectives.length === 0
  ) {
    throw new UserError(
      `Failed to resolve allowed-user ${
        quotedEntries(resolution.unresolved, "allowed-user")
      }: none of the configured allowed-users exist on ${providerUrl} and no ` +
        "allowed-collectives are set, so admission would be open to every " +
        `user of ${providerUrl}. Fix the names in auth.allowed-users.`,
    );
  }
}

/** One configured entry and what the provider said about it. */
export interface AccessListCheckEntry {
  readonly kind: AccessListKind;
  readonly entry: string;
  readonly username: string;
  readonly status: "resolved" | "not-found";
  readonly sub?: string;
}

/** Result of checking the configured lists against the provider. */
export interface AccessListCheck {
  readonly entries: AccessListCheckEntry[];
  /** False when `swamp serve` would refuse to start with these lists. */
  readonly wouldStart: boolean;
  /** Why serve would refuse to start; set when `wouldStart` is false. */
  readonly refusal?: string;
}

/**
 * Looks up every configured admin and allowed-user, the way `swamp serve`
 * does at startup without a cache, and reports which names the provider
 * does not know and whether serve would start. Nothing is persisted. A
 * lookup failure other than not-found throws, as it would at startup.
 */
export async function checkAccessLists(
  configured: {
    readonly admins: readonly string[];
    readonly allowedUsers: readonly string[];
    readonly allowedCollectives: readonly string[];
  },
  resolve: UsernameResolver,
  providerUrl: string,
): Promise<AccessListCheck> {
  const resolution = await resolveAccessLists({
    admins: configured.admins,
    allowedUsers: configured.allowedUsers,
    cache: {},
    mode: "full",
    resolve,
    providerUrl,
    now: () => new Date().toISOString(),
  });

  // Report in configured order; the cache holds a sub only for names that
  // resolved.
  const entries: AccessListCheckEntry[] = configuredEntries(
    configured.admins,
    configured.allowedUsers,
  ).map(({ kind, entry, username }) => {
    const sub = resolution.cache[resolvedCacheKey(kind, username)];
    return sub
      ? { kind, entry, username, status: "resolved" as const, sub }
      : { kind, entry, username, status: "not-found" as const };
  });

  try {
    assertAccessListsUsable(configured, resolution, providerUrl);
    return { entries, wouldStart: true };
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    return { entries, wouldStart: false, refusal: err.message };
  }
}

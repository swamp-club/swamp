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
 * a resolved name is pinned and never looked up again, so an edit cannot
 * re-point it to whoever registers the name later; skipped names stay skipped,
 * since re-checking would let someone claim a typo'd admin name
 */

import { UserError } from "../domain/errors.ts";
import {
  UsernameLookupRefusedError,
  UsernameNotFoundError,
} from "./oauth_client.ts";

export type AccessListKind = "admin" | "allowed-user";

export type ResolutionMode = "full" | "cached";

export type UsernameResolver = (username: string) => Promise<string>;

export interface UnresolvedEntry {
  readonly kind: AccessListKind;
  readonly entry: string;
  readonly username: string;
  readonly notFoundSince?: string;
  readonly reason?: string;
}

export interface ResolvedEntry {
  readonly kind: AccessListKind;
  readonly entry: string;
  readonly username: string;
  readonly sub: string;
  readonly fromCache: boolean;
}

export interface AccessListResolution {
  readonly admins: string[];
  readonly allowedUsers: string[];
  readonly usernamesBySub: Record<string, string>;
  readonly cache: Record<string, string>;
  readonly cacheChanged: boolean;
  readonly resolved: ResolvedEntry[];
  readonly unresolved: UnresolvedEntry[];
}

export interface ResolveAccessListsInput {
  readonly admins: readonly string[];
  readonly allowedUsers: readonly string[];
  readonly cache: Readonly<Record<string, string>>;
  readonly mode: ResolutionMode;
  readonly resolve: UsernameResolver | null;
  readonly providerUrl: string;
  readonly now: () => string;
}

export function usernameOf(entry: string): string {
  return entry.startsWith("user:") ? entry.slice("user:".length) : entry;
}

export function resolvedCacheKey(
  kind: AccessListKind,
  username: string,
): string {
  return kind === "admin" ? username : `allowed:${username}`;
}

export function unresolvedCacheKey(
  kind: AccessListKind,
  username: string,
): string {
  return `unresolved:${resolvedCacheKey(kind, username)}`;
}

/**
 * provider usernames never contain a colon, and one that did could spell
 * another entry's cache key
 */
function notPlainUsernameReason(username: string): string | undefined {
  if (!username.includes(":")) return undefined;
  if (username.startsWith("group:") || username.startsWith("idp-group:")) {
    return "groups are not supported in --admins / --allowed-users with --auth-mode oauth; list the user names instead";
  }
  if (username.startsWith("collective:")) {
    return "collectives are not supported in --admins / --allowed-users with --auth-mode oauth; admit a collective with --allowed-collectives and list admins by user name";
  }
  return "not a plain username: it contains ':', so it can never match a provider account";
}

/**
 * the cache comes from JSON.parse, so a plain index would find Object.prototype
 * members for names like constructor
 */
function cached(
  cache: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(cache, key) ? cache[key] : undefined;
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

export function listUncachedNames(
  admins: readonly string[],
  allowedUsers: readonly string[],
  cache: Readonly<Record<string, string>>,
): string[] {
  return configuredEntries(admins, allowedUsers)
    .filter(({ kind, username }) =>
      notPlainUsernameReason(username) === undefined &&
      !cached(cache, resolvedCacheKey(kind, username)) &&
      !cached(cache, unresolvedCacheKey(kind, username))
    )
    .map(({ kind, username }) => resolvedCacheKey(kind, username));
}

export function chooseResolutionMode(
  admins: readonly string[],
  allowedUsers: readonly string[],
  cache: Readonly<Record<string, string>>,
): ResolutionMode {
  return listUncachedNames(admins, allowedUsers, cache).length > 0
    ? "full"
    : "cached";
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
  if (mode === "full" && !resolve) {
    throw new Error("A resolver is required in full mode");
  }

  const admins: string[] = [];
  const allowedUsers: string[] = [];
  const usernamesBySub: Record<string, string> = Object.create(null);
  const nextCache: Record<string, string> = Object.create(null);
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
    const notFoundSince = cached(cache, markerKey) ??
      cached(nextCache, markerKey) ?? now();
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
    const notPlain = notPlainUsernameReason(entry.username);
    if (notPlain !== undefined) {
      // No cache read, no lookup and no record: the entry may spell
      // another entry's cache key.
      unresolved.push({ ...entry, reason: notPlain });
      continue;
    }
    const cachedSub = cached(
      cache,
      resolvedCacheKey(entry.kind, entry.username),
    );
    const knownMissing = cached(
      cache,
      unresolvedCacheKey(entry.kind, entry.username),
    ) !== undefined;

    if (cachedSub) {
      accept(entry, cachedSub, true);
      continue;
    }
    if (mode === "cached" || knownMissing) {
      skip(entry);
      continue;
    }

    try {
      accept(entry, await resolve!(entry.username), false);
    } catch (err) {
      if (err instanceof UsernameNotFoundError) {
        skip(entry, errorMessage(err));
        continue;
      }
      const label = entry.kind === "admin" ? "admin" : "allowed-user";
      // A refusal already says which scope the credential needs.
      const hint = err instanceof UsernameLookupRefusedError
        ? ""
        : ` Check that ${providerUrl} is reachable and that the credential can look up users, then retry.`;
      throw new UserError(
        `Failed to resolve ${label} '${entry.entry}': ${
          errorMessage(err)
        }.${hint}`,
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
 * fails closed: needs at least one admin and restricted admission, since
 * checkAdmission admits every user when allowed-users and collectives are both
 * empty
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
        "Serve will not start without an admin. Fix the names in --admins / auth.admins.",
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
        `user of ${providerUrl}. Fix the names in --allowed-users / auth.allowed-users.`,
    );
  }
}

export interface AccessListCheckEntry {
  readonly kind: AccessListKind;
  readonly entry: string;
  readonly username: string;
  readonly status: "resolved" | "not-found";
  readonly sub?: string;
}

export interface AccessListCheck {
  readonly entries: AccessListCheckEntry[];
  readonly wouldStart: boolean;
  readonly refusal?: string;
}

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

  const entries: AccessListCheckEntry[] = configuredEntries(
    configured.admins,
    configured.allowedUsers,
  ).map(({ kind, entry, username }) => {
    // An entry that is not a plain username has no record of its own; its
    // key may be another entry's.
    const sub = notPlainUsernameReason(username) === undefined
      ? resolution.cache[resolvedCacheKey(kind, username)]
      : undefined;
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

export interface PersonalCollective {
  readonly slug: string;
  readonly username: string;
  readonly message: string;
}

function personalCollective(slug: string): PersonalCollective {
  return {
    slug,
    username: slug,
    message:
      `allowed collective '${slug}' is the personal collective of user '${slug}': ` +
      "swamp-club leaves personal collectives out of OAuth logins, so it admits no one. " +
      `Add '${slug}' to --allowed-users / auth.allowed-users to admit that user.`,
  };
}

/**
 * a personal collective's slug is its owner's username, and swamp-club refuses
 * a username another collective's slug holds, so a slug that is a username is
 * personal
 */
export function personalCollectivesAmongResolved(
  allowedCollectives: readonly string[],
  resolved: readonly ResolvedEntry[],
): PersonalCollective[] {
  const usernames = new Set(resolved.map((r) => r.username));
  return allowedCollectives
    .filter((slug) => usernames.has(slug))
    .map(personalCollective);
}

/** a lookup that fails says nothing, so it is never reported as personal */
export async function findPersonalCollectives(
  allowedCollectives: readonly string[],
  resolve: UsernameResolver,
): Promise<PersonalCollective[]> {
  const found: PersonalCollective[] = [];
  for (const slug of allowedCollectives) {
    try {
      await resolve(slug);
      found.push(personalCollective(slug));
    } catch {
      continue;
    }
  }
  return found;
}

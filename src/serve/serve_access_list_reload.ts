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
} from "./oauth_access_list_resolution.ts";
import { UsernameNotFoundError } from "./oauth_client.ts";

/**
 * Stands in for an allowed-users list that removals and deferred names left
 * empty, so admission stays closed: no subject or principal id contains NUL.
 */
export const CLOSED_ALLOWED_USERS_ENTRY = "\u0000no-user-admitted";

export interface AllowedUsersReloadInput {
  readonly configured: readonly string[];
  /** the names this instance had configured before the reload */
  readonly previouslyConfigured: readonly string[];
  readonly allowedCollectives: readonly string[];
  /** read from the vault now, so a peer's records since startup count */
  readonly stored: Readonly<Record<string, string>>;
  readonly cache: Readonly<Record<string, string>>;
  /** null without a club API key: new names then wait for a restart */
  readonly resolve:
    | ((name: string, signal: AbortSignal) => Promise<string>)
    | null;
  readonly now: () => string;
  readonly limits?: {
    readonly concurrency: number;
    readonly deadlineMs: number;
    readonly maxNewNames: number;
  };
}

export interface SkippedName {
  readonly name: string;
  readonly reason: string;
}

export interface AllowedUsersReloadPlan {
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

// startup's bounds for looking names up, so a reload holds its lock as briefly
const RELOAD_LOOKUP_LIMITS = {
  concurrency: 4,
  deadlineMs: 60_000,
  maxNewNames: 200,
};

function own(
  cache: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(cache, key) ? cache[key] : undefined;
}

const ALLOWED_PREFIX = resolvedCacheKey("allowed-user", "");
const UNRESOLVED_ALLOWED_PREFIX = unresolvedCacheKey("allowed-user", "");

function allowedName(key: string): string | undefined {
  if (key.startsWith(UNRESOLVED_ALLOWED_PREFIX)) {
    return key.slice(UNRESOLVED_ALLOWED_PREFIX.length);
  }
  if (key.startsWith(ALLOWED_PREFIX)) return key.slice(ALLOWED_PREFIX.length);
  return undefined;
}

type NameLookup =
  | { readonly kind: "sub"; readonly sub: string }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "defer"; readonly reason: string };

const NO_API_KEY =
  "not looked up yet and serve has no club API key; set SWAMP_API_KEY or --club-api-key-file, or restart serve";

/**
 * Removals always apply; a name that cannot be looked up now waits unmarked,
 * so the next reload retries it.
 */
export async function planAllowedUsersReload(
  input: AllowedUsersReloadInput,
): Promise<AllowedUsersReloadPlan> {
  const limits = input.limits ?? RELOAD_LOOKUP_LIMITS;
  const configuredNames = new Set(input.configured.map(usernameOf));
  const removed = new Set(
    input.previouslyConfigured.map(usernameOf).filter((name) =>
      !configuredNames.has(name)
    ),
  );
  // a peer's records count; only names this reload removed lose theirs
  const cache: Record<string, string> = Object.create(null);
  for (const source of [input.cache, input.stored]) {
    for (const [key, value] of Object.entries(source)) {
      const name = allowedName(key);
      if (name === undefined || !removed.has(name)) cache[key] = value;
    }
  }

  const lookups = new Map<string, NameLookup>();
  const fresh: string[] = [];
  for (const entry of input.configured) {
    const name = usernameOf(entry);
    const notPlain = notPlainUsernameReason(name);
    const sub = own(cache, resolvedCacheKey("allowed-user", name));
    const notFoundSince = own(cache, unresolvedCacheKey("allowed-user", name));
    if (notPlain !== undefined) {
      lookups.set(name, { kind: "skip", reason: notPlain });
    } else if (sub !== undefined) {
      lookups.set(name, { kind: "sub", sub });
    } else if (notFoundSince !== undefined) {
      lookups.set(name, {
        kind: "skip",
        reason: `not found since ${notFoundSince}`,
      });
    } else if (!lookups.has(name)) {
      fresh.push(name);
      lookups.set(name, { kind: "defer", reason: NO_API_KEY });
    }
  }

  const resolve = input.resolve;
  if (fresh.length > limits.maxNewNames) {
    const reason =
      `not looked up: ${fresh.length} new names, more than the ${limits.maxNewNames} one reload looks up; add them in smaller batches`;
    for (const name of fresh) lookups.set(name, { kind: "defer", reason });
  } else if (resolve !== null && fresh.length > 0) {
    const signal = AbortSignal.timeout(limits.deadlineMs);
    let next = 0;
    const worker = async () => {
      while (next < fresh.length) {
        const name = fresh[next++];
        try {
          const sub = await resolve(name, signal);
          cache[resolvedCacheKey("allowed-user", name)] = sub;
          lookups.set(name, { kind: "sub", sub });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof UsernameNotFoundError) {
            cache[unresolvedCacheKey("allowed-user", name)] = input.now();
            lookups.set(name, { kind: "skip", reason: message });
          } else {
            lookups.set(name, {
              kind: "defer",
              reason: `lookup failed: ${message}`,
            });
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(limits.concurrency, fresh.length) },
        worker,
      ),
    );
  }

  const allowedUsers: string[] = [];
  const namesInForce: string[] = [];
  const usernamesBySub: Record<string, string> = Object.create(null);
  const deferred: SkippedName[] = [];
  const skipped: SkippedName[] = [];
  for (const entry of input.configured) {
    const name = usernameOf(entry);
    const lookup = lookups.get(name)!;
    if (lookup.kind === "sub") {
      allowedUsers.push(lookup.sub);
      namesInForce.push(entry);
      usernamesBySub[lookup.sub] = name;
    } else if (lookup.kind === "skip") {
      skipped.push({ name: entry, reason: lookup.reason });
    } else {
      deferred.push({ name: entry, reason: lookup.reason });
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
    cacheChanged: !sameEntries(input.stored, cache),
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

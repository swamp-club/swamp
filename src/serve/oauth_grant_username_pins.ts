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
 * Resolves and pins the `username:<name>` subjects of grant files to OAuth
 * subjects (swamp-club#3123).
 *
 * Pins live in their own `_token-secrets` key, apart from the admin and
 * allowed-user resolutions. The rules are stricter than theirs on purpose:
 *
 * - A pinned name is used as pinned and never looked up again, so a rename
 *   or a re-registered name never re-points a grant.
 * - A name the provider reports as not found is recorded with the time it
 *   was first seen missing and never looked up again; its file stays
 *   rejected until the name is removed from it. A typo can then never be
 *   claimed by whoever registers that name later.
 * - Any other lookup failure records nothing.
 * - A record is forgotten only when its name is in no grant file and every
 *   grant source loaded, so a source held back keeps the pins of its names.
 *   Forgetting a name is the only way to look it up afresh.
 *
 * The key is read again on every resolve, so a pin a peer instance wrote
 * since wins over a fresh lookup, and written before the caller acts on the
 * answer, so a refused start still records a missing name.
 */

import type {
  GrantUsernameResolver,
  UsernameLookup,
  UsernameResolutionRequest,
} from "../domain/access/grant_username_resolution.ts";
import { UsernameNotFoundError } from "./oauth_client.ts";

/** The `_token-secrets` key holding grant-file username pins. */
export const OAUTH_GRANT_USERNAMES_KEY = "oauth-resolved-grant-usernames";

/** How many new names one resolve looks up at once. */
export const GRANT_USERNAME_LOOKUP_CONCURRENCY = 4;
/** How long one resolve may spend looking names up, in total. */
export const GRANT_USERNAME_LOOKUP_DEADLINE_MS = 60_000;
/** How many new names one resolve looks up at most. */
export const MAX_NEW_GRANT_USERNAMES = 200;

/** The stored pins. */
export interface GrantUsernamePins {
  /** Username to the sub it resolved to. */
  readonly pinned: Record<string, string>;
  /** Username to when the provider first reported it not found. */
  readonly missing: Record<string, string>;
}

/** Reads and writes the pins. */
export interface GrantUsernamePinStore {
  /** Throws when the pins cannot be read; absent pins read as empty. */
  read(): Promise<GrantUsernamePins>;
  write(pins: GrantUsernamePins): Promise<void>;
}

/** Looks one username up on the provider; throws UsernameNotFoundError. */
export type GrantUsernameLookup = (
  username: string,
  signal: AbortSignal,
) => Promise<string>;

export interface OAuthGrantUsernameResolverOptions {
  readonly store: GrantUsernamePinStore;
  /**
   * Looks up a name that has no record, or null when no credential to look
   * names up is available; new names are then left unresolved with
   * {@link noLookupMessage}.
   */
  readonly lookup: () => GrantUsernameLookup | null;
  readonly noLookupMessage: string;
  readonly providerUrl: string;
  /** Current time as an ISO string; injected for tests. */
  readonly now?: () => string;
  readonly concurrency?: number;
  readonly deadlineMs?: number;
  readonly maxNewNames?: number;
  /** Called with each name newly pinned or recorded missing. */
  readonly onRecorded?: (event: GrantUsernameRecordEvent) => void;
}

export type GrantUsernameRecordEvent =
  | { readonly kind: "pinned"; readonly username: string; readonly sub: string }
  | { readonly kind: "missing"; readonly username: string }
  | { readonly kind: "forgotten"; readonly username: string };

function own(record: Readonly<Record<string, string>>, key: string) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parses stored pins, refusing anything that is not their shape. */
export function parseGrantUsernamePins(raw: string): GrantUsernamePins {
  const value: unknown = JSON.parse(raw);
  const isStringRecord = (v: unknown): v is Record<string, string> =>
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string");
  if (
    typeof value !== "object" || value === null ||
    !isStringRecord((value as Record<string, unknown>).pinned) ||
    !isStringRecord((value as Record<string, unknown>).missing)
  ) {
    throw new Error(
      `${OAUTH_GRANT_USERNAMES_KEY} does not hold grant username pins`,
    );
  }
  const { pinned, missing } = value as {
    pinned: Record<string, string>;
    missing: Record<string, string>;
  };
  return {
    pinned: Object.assign(Object.create(null), pinned),
    missing: Object.assign(Object.create(null), missing),
  };
}

export function serializeGrantUsernamePins(pins: GrantUsernamePins): string {
  return JSON.stringify({ pinned: pins.pinned, missing: pins.missing });
}

/** A pin store over the `_token-secrets` vault. */
export function vaultGrantUsernamePinStore(
  vault: {
    list(): Promise<string[]>;
    get(key: string): Promise<string>;
    put(key: string, value: string): Promise<void>;
  },
): GrantUsernamePinStore {
  return {
    async read() {
      // A failed get must not read as "no pins": every pinned name would be
      // looked up again and could be re-pointed. Only a listing without the
      // key means there are none.
      if (!(await vault.list()).includes(OAUTH_GRANT_USERNAMES_KEY)) {
        return { pinned: Object.create(null), missing: Object.create(null) };
      }
      return parseGrantUsernamePins(await vault.get(OAUTH_GRANT_USERNAMES_KEY));
    },
    write: (pins) =>
      vault.put(OAUTH_GRANT_USERNAMES_KEY, serializeGrantUsernamePins(pins)),
  };
}

const MISSING_RECOVERY = "A name first seen missing is never looked up " +
  "again, so nobody who registers it later can be granted by this entry. To " +
  "look it up afresh, remove it from every grant file, reload or restart " +
  "serve, then add it back";

function missingMessage(since: string): string {
  return `not found on the OAuth provider when first looked up (${since}). ${MISSING_RECOVERY}`;
}

export function createOAuthGrantUsernameResolver(
  options: OAuthGrantUsernameResolverOptions,
): GrantUsernameResolver {
  const now = options.now ?? (() => new Date().toISOString());
  const concurrency = options.concurrency ?? GRANT_USERNAME_LOOKUP_CONCURRENCY;
  const deadlineMs = options.deadlineMs ?? GRANT_USERNAME_LOOKUP_DEADLINE_MS;
  const maxNewNames = options.maxNewNames ?? MAX_NEW_GRANT_USERNAMES;
  // Startup, the auto-reload and access.reload can resolve at once; each
  // reads and writes the whole key, so they take turns.
  let turn: Promise<unknown> = Promise.resolve();

  const resolveOnce = async (
    request: UsernameResolutionRequest,
  ): Promise<ReadonlyMap<string, UsernameLookup>> => {
    const stored = await options.store.read();
    const answers = new Map<string, UsernameLookup>();
    const fresh: string[] = [];

    for (const name of request.names) {
      const sub = own(stored.pinned, name);
      const since = own(stored.missing, name);
      if (sub !== undefined) {
        answers.set(name, { status: "resolved", sub });
      } else if (since !== undefined) {
        answers.set(name, {
          status: "unresolved",
          message: missingMessage(since),
        });
      } else {
        fresh.push(name);
      }
    }

    const newPins = new Map<string, string>();
    const newMissing = new Map<string, string>();
    const lookup = fresh.length > 0 ? options.lookup() : null;
    if (fresh.length > maxNewNames) {
      const message =
        `not looked up: the grant files name ${fresh.length} usernames serve has not resolved, more than the ${maxNewNames} it looks up in one load. Add them in smaller batches`;
      for (const name of fresh) {
        answers.set(name, { status: "unresolved", message });
      }
    } else if (fresh.length > 0 && lookup === null) {
      for (const name of fresh) {
        answers.set(name, {
          status: "unresolved",
          message: options.noLookupMessage,
        });
      }
    } else if (lookup !== null) {
      const signal = AbortSignal.timeout(deadlineMs);
      let next = 0;
      const worker = async () => {
        while (next < fresh.length) {
          const name = fresh[next++];
          try {
            const sub = await lookup(name, signal);
            newPins.set(name, sub);
            answers.set(name, { status: "resolved", sub });
          } catch (err) {
            if (err instanceof UsernameNotFoundError) {
              newMissing.set(name, now());
              answers.set(name, {
                status: "unresolved",
                message: `${
                  errorMessage(err)
                } (looked up with ${options.providerUrl}/api/auth/resolve-user); recorded as missing. ${MISSING_RECOVERY}`,
              });
            } else {
              answers.set(name, {
                status: "unresolved",
                message: `could not be looked up on ${options.providerUrl}: ${
                  errorMessage(err)
                }. Nothing was recorded; it is looked up again when the grant file changes, on swamp access reload, or when serve restarts`,
              });
            }
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, fresh.length) },
          () => worker(),
        ),
      );
    }

    const forgotten: string[] = [];
    if (request.complete) {
      const named = new Set(request.names);
      for (
        const name of [
          ...Object.keys(stored.pinned),
          ...Object.keys(stored.missing),
        ]
      ) {
        if (!named.has(name)) forgotten.push(name);
      }
    }
    if (newPins.size === 0 && newMissing.size === 0 && forgotten.length === 0) {
      return answers;
    }

    // Read again and merge rather than write what was read above: a peer
    // instance sharing the vault may have recorded names since, and writing
    // the whole key over them would drop a pin (re-pointable on its next
    // lookup) or a missing-name record (claimable). A record already stored
    // wins over this resolve's answer for the same name.
    const latest = await options.store.read();
    const pinned: Record<string, string> = Object.assign(
      Object.create(null),
      latest.pinned,
    );
    const missing: Record<string, string> = Object.assign(
      Object.create(null),
      latest.missing,
    );
    const events: GrantUsernameRecordEvent[] = [];
    for (const name of forgotten) {
      delete pinned[name];
      delete missing[name];
      events.push({ kind: "forgotten", username: name });
    }
    const recorded = (name: string): boolean => {
      const peerSub = own(pinned, name);
      const peerSince = own(missing, name);
      if (peerSub !== undefined) {
        answers.set(name, { status: "resolved", sub: peerSub });
      } else if (peerSince !== undefined) {
        answers.set(name, {
          status: "unresolved",
          message: missingMessage(peerSince),
        });
      }
      return peerSub !== undefined || peerSince !== undefined;
    };
    for (const [name, sub] of newPins) {
      if (recorded(name)) continue;
      pinned[name] = sub;
      events.push({ kind: "pinned", username: name, sub });
    }
    for (const [name, since] of newMissing) {
      if (recorded(name)) continue;
      missing[name] = since;
      events.push({ kind: "missing", username: name });
    }
    await options.store.write({ pinned, missing });
    for (const event of events) options.onRecorded?.(event);
    return answers;
  };

  return {
    resolve(request) {
      const result = turn.then(() => resolveOnce(request));
      turn = result.catch(() => {});
      return result;
    },
  };
}

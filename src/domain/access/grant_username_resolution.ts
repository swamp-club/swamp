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
 * Turns the `username:<name>` subjects of parsed grant files into
 * `user:<sub>` subjects (swamp-club#3123). Grants keep matching the OAuth
 * subject; a username is only a way to name it in the file.
 *
 * Looking a name up, and pinning what it resolved to, is the resolver's
 * job. This service only applies the answers: an entry whose name resolved
 * names the sub, and a file with any name that did not resolve is rejected
 * whole, as a file with any invalid subject is. Skipping the entry instead
 * would silently drop a deny.
 */

import {
  entryIdentityKey,
  type GrantFileEntry,
  type GrantFileError,
  type ParsedGrantFileEntry,
  USERNAME_SUBJECT_PREFIX,
} from "./grant_file.ts";

/** What a resolver says about one username. */
export type UsernameLookup =
  | { readonly status: "resolved"; readonly sub: string }
  /** Not found, not looked up, or not resolvable here; the file is rejected. */
  | { readonly status: "unresolved"; readonly message: string };

export interface UsernameResolutionRequest {
  /** Every username named by a grant source that loaded, deduplicated. */
  readonly names: readonly string[];
  /**
   * True when every grant source loaded. A resolver may forget a name that
   * is in no file only then: a source held back still names its usernames.
   */
  readonly complete: boolean;
}

/** Resolves grant-file usernames to OAuth subjects. */
export interface GrantUsernameResolver {
  /** Answers every requested name; throws only if it cannot answer at all. */
  resolve(
    request: UsernameResolutionRequest,
  ): Promise<ReadonlyMap<string, UsernameLookup>>;
}

/** One parsed grant source to resolve. */
export interface ParsedGrantSource {
  /** How errors name the file. */
  readonly filename: string;
  readonly entries: readonly ParsedGrantFileEntry[];
}

/** A source after resolution: its entries, or the errors that reject it. */
export interface ResolvedGrantSource {
  readonly entries: GrantFileEntry[];
  readonly errors: GrantFileError[];
}

export interface GrantUsernameResolution {
  /** By the same keys as the input. */
  readonly sources: Map<string, ResolvedGrantSource>;
  /** Resolved sub to the username that named it, for display. */
  readonly usernamesBySub: Record<string, string>;
}

/** Resolves usernames without a provider: every name is rejected. */
export function unresolvableUsernames(message: string): GrantUsernameResolver {
  return {
    resolve: (request) =>
      Promise.resolve(
        new Map(
          request.names.map((
            name,
          ) => [name, { status: "unresolved", message }]),
        ),
      ),
  };
}

/**
 * Why a `username:` subject cannot be resolved outside OAuth mode: with
 * token auth a user principal already is its username, and without auth
 * there is none.
 */
export function usernameSubjectsNeedOAuthMessage(authMode: string): string {
  return `username subjects need --auth-mode oauth (this serve runs with --auth-mode ${authMode}). With --auth-mode token a user principal is its username, so write user:<name>`;
}

/** The usernames the entries name, in first-seen order. */
export function grantFileUsernames(
  entries: Iterable<ParsedGrantFileEntry>,
): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.subject.kind === "username") names.add(entry.subject.name);
  }
  return [...names];
}

export async function resolveGrantFileUsernames(
  sources: ReadonlyMap<string, ParsedGrantSource>,
  resolver: GrantUsernameResolver,
  options: { readonly complete: boolean },
): Promise<GrantUsernameResolution> {
  const names = grantFileUsernames(
    [...sources.values()].flatMap((source) => source.entries),
  );
  const lookups = await resolver.resolve({
    names,
    complete: options.complete,
  });

  const usernamesBySub: Record<string, string> = Object.create(null);
  const resolved = new Map<string, ResolvedGrantSource>();
  for (const [key, source] of sources) {
    resolved.set(key, resolveSource(source, lookups, usernamesBySub));
  }
  return { sources: resolved, usernamesBySub };
}

function resolveSource(
  source: ParsedGrantSource,
  lookups: ReadonlyMap<string, UsernameLookup>,
  usernamesBySub: Record<string, string>,
): ResolvedGrantSource {
  const entries: GrantFileEntry[] = [];
  const errors: GrantFileError[] = [];
  const reported = new Set<string>();
  const seenKeys = new Set<string>();

  for (const entry of source.entries) {
    let resolvedEntry: GrantFileEntry;
    if (entry.subject.kind === "username") {
      const name = entry.subject.name;
      const lookup = lookups.get(name) ??
        { status: "unresolved", message: "the name was not looked up" };
      if (lookup.status !== "resolved") {
        if (!reported.has(name)) {
          reported.add(name);
          errors.push({
            filename: source.filename,
            message:
              `Subject "${USERNAME_SUBJECT_PREFIX}${name}": ${lookup.message}`,
          });
        }
        continue;
      }
      usernamesBySub[lookup.sub] = name;
      resolvedEntry = { ...entry, subject: { kind: "user", name: lookup.sub } };
    } else {
      resolvedEntry = { ...entry, subject: entry.subject };
    }

    // The parser rejected duplicates as written; a username and the sub it
    // resolves to are one subject, so check again as resolved.
    const key = entryIdentityKey(resolvedEntry);
    if (seenKeys.has(key)) {
      errors.push({
        filename: source.filename,
        message: `Duplicate grant entry: ${
          entry.subject.kind === "username"
            ? `"${USERNAME_SUBJECT_PREFIX}${entry.subject.name}" resolves to user:${resolvedEntry.subject.name}, which another entry already grants the same way`
            : `user:${resolvedEntry.subject.name} is already granted the same way by a username entry`
        }`,
      });
      continue;
    }
    seenKeys.add(key);
    entries.push(resolvedEntry);
  }

  return errors.length > 0 ? { entries: [], errors } : { entries, errors };
}

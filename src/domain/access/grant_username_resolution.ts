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
 * a file with any name that did not resolve is rejected whole, like one with an
 * invalid subject; skipping the entry would silently drop a deny
 */

import {
  entryIdentityKey,
  type GrantFileEntry,
  type GrantFileError,
  type ParsedGrantFileEntry,
  USERNAME_SUBJECT_PREFIX,
} from "./grant_file.ts";

export type UsernameLookup =
  | { readonly status: "resolved"; readonly sub: string }
  | { readonly status: "unresolved"; readonly message: string };

export interface UsernameResolutionRequest {
  readonly names: readonly string[];
  /**
   * true when every grant source loaded; a resolver may forget a name in no
   * file only then, since a source held back still names its usernames
   */
  readonly complete: boolean;
}

export interface GrantUsernameResolver {
  resolve(
    request: UsernameResolutionRequest,
  ): Promise<ReadonlyMap<string, UsernameLookup>>;
}

export interface ParsedGrantSource {
  readonly filename: string;
  readonly entries: readonly ParsedGrantFileEntry[];
}

export interface ResolvedGrantSource {
  readonly entries: GrantFileEntry[];
  readonly errors: GrantFileError[];
}

export interface GrantUsernameResolution {
  readonly sources: Map<string, ResolvedGrantSource>;
  readonly usernamesBySub: Record<string, string>;
}

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
 * with token auth a user principal already is its username, and without auth
 * there is none, so username subjects need OAuth mode
 */
export function usernameSubjectsNeedOAuthMessage(authMode: string): string {
  return `username subjects need --auth-mode oauth (this serve runs with --auth-mode ${authMode}). With --auth-mode token a user principal is its username, so write user:<name>`;
}

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

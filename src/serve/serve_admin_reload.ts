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
  resolvedCacheKey,
  usernameOf,
} from "./oauth_access_list_resolution.ts";

/** the subject startup resolved an OAuth admin name to, from the name map */
export function oauthAdminSubjectOf(
  cache: Readonly<Record<string, string>> | undefined,
  entry: string,
): string | undefined {
  if (!cache) return undefined;
  const key = resolvedCacheKey("admin", usernameOf(entry));
  return Object.hasOwn(cache, key) ? `user:${cache[key]}` : undefined;
}

export interface AdminReloadInput {
  /** the configured admin entries in force: startup's, less reloaded removals */
  readonly configuredBefore: readonly string[];
  readonly configuredAfter: readonly string[];
  /** the admin subjects in force, as grants are written for them */
  readonly inForce: readonly string[];
  /** the subject an entry was put in force as; undefined when it never was */
  subjectOf(entry: string): string | undefined;
}

export interface AdminReloadPlan {
  readonly inForce: readonly string[];
  /** the configured entries in force after the reload */
  readonly configured: readonly string[];
  readonly removedSubjects: readonly string[];
  /** added entries: they wait for a restart, which writes their grants */
  readonly waiting: readonly string[];
  /** subjects of waiting entries already known, whose grants stay as they are */
  readonly waitingSubjects: readonly string[];
}

export const ADMIN_ADDITION_NEEDS_RESTART =
  "adding an admin needs a restart; serve writes new admin grants only at startup";

/**
 * removing an admin applies on reload; adding one waits for a restart. An
 * entry that never resolved was never in force, so removing it revokes nothing
 */
export function planAdminReload(input: AdminReloadInput): AdminReloadPlan {
  const after = new Set(input.configuredAfter);
  const before = new Set(input.configuredBefore);
  const removedEntries = input.configuredBefore.filter((e) => !after.has(e));
  const waiting = input.configuredAfter.filter((e) => !before.has(e));
  const configured = input.configuredBefore.filter((e) => after.has(e));

  // two entries can name one subject; it stays while any of them does
  const keptSubjects = new Set(
    configured.map((e) => input.subjectOf(e)).filter((s) => s !== undefined),
  );
  const removedSubjects = [
    ...new Set(
      removedEntries.map((e) => input.subjectOf(e)).filter((s) =>
        s !== undefined && !keptSubjects.has(s)
      ) as string[],
    ),
  ];
  const removed = new Set(removedSubjects);
  return {
    inForce: input.inForce.filter((s) => !removed.has(s)),
    configured,
    removedSubjects,
    waiting,
    waitingSubjects: waiting
      .map((e) => input.subjectOf(e))
      .filter((s): s is string => s !== undefined),
  };
}

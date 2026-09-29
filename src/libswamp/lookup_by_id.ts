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

/** Options for an operation that takes a positional id-or-name argument. */
export interface LookupOptions {
  /**
   * Treat the argument as an id the caller already resolved, and look it up
   * by id only, so the operation acts on the resource the caller authorized.
   */
  byId?: boolean;
}

/**
 * Picks the lookup an operation uses for its id-or-name argument.
 *
 * With `byId`, the caller has already resolved the resource and passes its
 * id, so the operation must act on exactly that resource: it looks up by id
 * only, never by name, because a resource may be named with another's id.
 * A `byId` request whose deps do not wire a by-id lookup throws rather than
 * fall back to the name-first lookup, so a missing wire-up cannot quietly act
 * on a different resource than the caller authorized.
 */
export function selectLookup<T>(
  operation: string,
  byId: boolean | undefined,
  byIdOrName: (idOrName: string) => Promise<T>,
  byIdOnly: ((id: string) => Promise<T>) | undefined,
): (idOrName: string) => Promise<T> {
  if (!byId) return byIdOrName;
  if (!byIdOnly) {
    throw new Error(
      `${operation}: a by-id lookup was requested but none is wired`,
    );
  }
  return byIdOnly;
}

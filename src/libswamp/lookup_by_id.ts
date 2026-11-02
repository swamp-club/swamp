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

export interface LookupOptions {
  /**
   * look up by id only, so the operation acts on the resource the caller
   * authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized. Ids are not guaranteed
   * unique, so the lookup accepts only a resource with this name and the id.
   */
  expectedName?: string;
}

/**
 * with byId, look up by id only, never by name, and throw if no by-id lookup is
 * wired, so the operation cannot act on a different resource than the caller
 * authorized
 */
export function selectLookup<T>(
  operation: string,
  byId: boolean | undefined,
  byIdOrName: (idOrName: string) => Promise<T>,
  byIdOnly: ((id: string, expectedName?: string) => Promise<T>) | undefined,
  expectedName?: string,
): (idOrName: string) => Promise<T> {
  if (!byId) return byIdOrName;
  if (!byIdOnly) {
    throw new Error(
      `${operation}: a by-id lookup was requested but none is wired`,
    );
  }
  return (id) => byIdOnly(id, expectedName);
}

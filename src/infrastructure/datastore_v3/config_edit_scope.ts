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
 * The scope of a user's own edit or delete of a managed-config definition
 * (swamp-club#4097). Inside it, a v3 unit of work expects the version the
 * user started from ({@link ConfigEditBases}) for an edited or deleted
 * definition; outside it, the version a repository read when it saved.
 * Only the CLI's edit and delete commands open it: a system rewrite (a type
 * upgrade, a migration, an adoption) has no version a user started from,
 * and serve's own files are always the head.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const userConfigEdit = new AsyncLocalStorage<true>();

/** Runs `fn` as a user's edit or delete of managed config. */
export function runAsUserConfigEdit<T>(fn: () => Promise<T>): Promise<T> {
  return userConfigEdit.run(true, fn);
}

/** True inside {@link runAsUserConfigEdit}. */
export function inUserConfigEdit(): boolean {
  return userConfigEdit.getStore() === true;
}

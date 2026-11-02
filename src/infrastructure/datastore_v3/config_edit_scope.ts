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
 * inside it, a unit of work expects the version the user started from for an
 * edited or deleted definition; outside it, the version a repository read when
 * it saved. Only the CLI's edit and delete open it
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { OfflineConfigEditError } from "../../domain/datastore_v3/offline_write_policy.ts";
import { anyServeOffline } from "./serve_offline.ts";

const userConfigEdit = new AsyncLocalStorage<true>();

/**
 * refused while the command works offline: whether an edit is stale is serve's
 * to decide
 */
export function runAsUserConfigEdit<T>(
  fn: () => Promise<T>,
  what = "the definition",
  verb = "edited",
): Promise<T> {
  if (anyServeOffline()) {
    return Promise.reject(new OfflineConfigEditError(what, verb));
  }
  return userConfigEdit.run(true, fn);
}

export function inUserConfigEdit(): boolean {
  return userConfigEdit.getStore() === true;
}

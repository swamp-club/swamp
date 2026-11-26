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

import type { ModelDefinition } from "./model.ts";

const SYNC_DATA_READ =
  /\b(?:getLatestVersionSync|findByNameSync|listVersionsSync|getContentSync|findAllForModelSync|findAllGlobalSync|querySync)\b/;

// built-in types whose code reads data through the sync APIs; none does
const BUILT_IN_SYNC_READERS: ReadonlySet<string> = new Set();

/** whether code names any sync data API; a mention in a string counts too */
export function namesSyncDataReads(code: string): boolean {
  return SYNC_DATA_READ.test(code);
}

/**
 * whether a model's code may read data through the sync APIs, which a command
 * applying only part of the read model cannot bring up to date mid-call;
 * true when it cannot be told
 */
export function mayReadDataSynchronously(
  model: Pick<
    ModelDefinition,
    "type" | "methods" | "checks" | "readsDataSynchronously"
  >,
  methodName: string,
  builtIn: boolean,
): boolean {
  if (builtIn) return BUILT_IN_SYNC_READERS.has(model.type.normalized);
  if (model.readsDataSynchronously !== undefined) {
    return model.readsDataSynchronously;
  }
  // registered in this process with no bundle: the method's and the checks'
  // functions are the code that runs
  const code: string[] = [];
  for (
    const member of [
      model.methods[methodName],
      ...Object.values(model.checks ?? {}),
    ]
  ) {
    if (member === undefined) return true;
    if (typeof member.execute !== "function") return true;
    code.push(member.execute.toString());
  }
  return namesSyncDataReads(code.join("\n"));
}

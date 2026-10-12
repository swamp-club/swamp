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
 * What the data catalog holds for one data name, as plain data
 * (swamp-club#3258): the versions that have a row, and the name's forward.
 * History compaction folds each commit's {@link CatalogAction}s into it, so
 * a checkout that loads the compacted base rebuilds the rows a replay of
 * the compacted commits would have left.
 *
 * The fold keeps the catalog store's semantics: an upsert replaces a
 * version's row, a removal drops one or all of a name's rows, and a forward
 * replaces or ends the name's forward. An upsert that becomes the name's
 * latest row also ends its forward, as `CatalogStore.upsertNewVersion` does
 * ("a new latest version makes the name active again"); the read model's
 * catalog has no pending rows, so that is an upsert with no higher row.
 * Latest flags are derived from version order, so they are not part of the
 * state.
 *
 * @module
 */

import type { DataMetadata } from "../data/data_metadata.ts";
import type { CatalogAction } from "./catalog_projection.ts";

/** One data name's catalog state. */
export interface CatalogNameState {
  /** The rows, by version, in ascending version order. */
  readonly rows: readonly DataMetadata[];
  /** The name it forwards to, if any. */
  readonly forward: string | undefined;
}

/** A name with no rows and no forward. */
export const EMPTY_CATALOG_NAME: CatalogNameState = {
  rows: [],
  forward: undefined,
};

/**
 * Applies one commit's catalog actions, in order, and returns the new state
 * of each name they touched. `before` gives a name's state before the
 * commit.
 */
export function foldCatalogActions(
  actions: readonly CatalogAction[],
  before: (name: string) => CatalogNameState,
): Map<string, CatalogNameState> {
  const working = new Map<
    string,
    { rows: Map<number, DataMetadata>; forward: string | undefined }
  >();
  const stateOf = (name: string) => {
    let state = working.get(name);
    if (state === undefined) {
      const prior = before(name);
      state = {
        rows: new Map(prior.rows.map((row) => [row.version, row])),
        forward: prior.forward,
      };
      working.set(name, state);
    }
    return state;
  };
  for (const action of actions) {
    switch (action.kind) {
      case "upsert-version": {
        const state = stateOf(action.metadata.name);
        const latest = ![...state.rows.keys()].some((version) =>
          version > action.metadata.version
        );
        if (latest) state.forward = undefined;
        state.rows.set(action.metadata.version, action.metadata);
        break;
      }
      case "remove-version":
        stateOf(action.name).rows.delete(action.version);
        break;
      case "remove-name":
        stateOf(action.name).rows.clear();
        break;
      case "forward":
        stateOf(action.name).forward = action.to;
        break;
      case "end-forward":
        stateOf(action.name).forward = undefined;
        break;
    }
  }
  return new Map(
    [...working].map(([name, state]) => [name, {
      rows: [...state.rows.values()].sort((a, b) => a.version - b.version),
      forward: state.forward,
    }]),
  );
}

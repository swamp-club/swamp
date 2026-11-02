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
 * an upsert that becomes the name's latest row also ends its forward, as
 * CatalogStore.upsertNewVersion does; latest flags derive from version order
 * and are not part of the state
 */

import type { DataMetadata } from "../data/data_metadata.ts";
import type { CatalogAction } from "./catalog_projection.ts";

export interface CatalogNameState {
  readonly rows: readonly DataMetadata[];
  readonly forward: string | undefined;
}

export const EMPTY_CATALOG_NAME: CatalogNameState = {
  rows: [],
  forward: undefined,
};

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

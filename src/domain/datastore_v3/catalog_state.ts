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
  // greatest is the greatest row's version, so a commit's upserts cost what
  // they change rather than a scan of the name's rows each
  const working = new Map<
    string,
    {
      rows: Map<number, DataMetadata>;
      forward: string | undefined;
      greatest: number;
    }
  >();
  const greatestOf = (rows: Map<number, DataMetadata>) => {
    let greatest = -Infinity;
    for (const version of rows.keys()) {
      if (version > greatest) greatest = version;
    }
    return greatest;
  };
  const stateOf = (name: string) => {
    let state = working.get(name);
    if (state === undefined) {
      const prior = before(name);
      const rows = new Map(prior.rows.map((row) => [row.version, row]));
      state = { rows, forward: prior.forward, greatest: greatestOf(rows) };
      working.set(name, state);
    }
    return state;
  };
  for (const action of actions) {
    switch (action.kind) {
      case "upsert-version": {
        const state = stateOf(action.metadata.name);
        const version = action.metadata.version;
        if (state.greatest <= version) {
          state.forward = undefined;
          state.greatest = version;
        }
        state.rows.set(version, action.metadata);
        break;
      }
      case "remove-version": {
        const state = stateOf(action.name);
        if (!state.rows.delete(action.version)) break;
        if (action.version === state.greatest) {
          state.greatest = greatestOf(state.rows);
        }
        break;
      }
      case "remove-name": {
        const state = stateOf(action.name);
        state.rows.clear();
        state.greatest = -Infinity;
        break;
      }
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

/** what foldCatalogChanges reads of a name, as it was before the commit */
export interface CatalogBaseView {
  /** the greatest row's version past the excluded, if any */
  greatestRow(name: string, excluding: ReadonlySet<number>): number | undefined;
  row(name: string, version: number): DataMetadata | undefined;
  forward(name: string): string | undefined;
}

/**
 * one name's rows and forward after a commit, as what changed: the name's
 * other rows stay as they were unless `cleared` removes them
 */
export interface CatalogNameChange {
  readonly cleared: boolean;
  /** each row the commit leaves set, with the row it replaces */
  readonly put: ReadonlyMap<
    number,
    {
      readonly metadata: DataMetadata;
      readonly before: DataMetadata | undefined;
    }
  >;
  /** rows removed and not put again; some may never have existed */
  readonly removed: ReadonlySet<number>;
  readonly forward: string | undefined;
  readonly forwardBefore: string | undefined;
}

/**
 * foldCatalogActions as changes: reads a point per touched row and the
 * greatest row per upsert, never the name's whole state
 */
export function foldCatalogChanges(
  actions: readonly CatalogAction[],
  view: CatalogBaseView,
): Map<string, CatalogNameChange> {
  const working = new Map<
    string,
    {
      cleared: boolean;
      put: Map<number, DataMetadata>;
      removed: Set<number>;
      forward: string | undefined;
      forwardBefore: string | undefined;
    }
  >();
  const stateOf = (name: string) => {
    let state = working.get(name);
    if (state === undefined) {
      const forward = view.forward(name);
      state = {
        cleared: false,
        put: new Map(),
        removed: new Set(),
        forward,
        forwardBefore: forward,
      };
      working.set(name, state);
    }
    return state;
  };
  for (const action of actions) {
    switch (action.kind) {
      case "upsert-version": {
        const state = stateOf(action.metadata.name);
        const version = action.metadata.version;
        let greater = false;
        for (const put of state.put.keys()) {
          if (put > version) greater = true;
        }
        if (!greater && !state.cleared) {
          const before = view.greatestRow(action.metadata.name, state.removed);
          greater = before !== undefined && before > version;
        }
        if (!greater) state.forward = undefined;
        state.put.set(version, action.metadata);
        state.removed.delete(version);
        break;
      }
      case "remove-version": {
        const state = stateOf(action.name);
        state.put.delete(action.version);
        if (!state.cleared) state.removed.add(action.version);
        break;
      }
      case "remove-name": {
        const state = stateOf(action.name);
        state.cleared = true;
        state.put.clear();
        state.removed.clear();
        break;
      }
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
      cleared: state.cleared,
      put: new Map(
        [...state.put].map(([version, metadata]) => [version, {
          metadata,
          before: view.row(name, version),
        }]),
      ),
      removed: state.removed,
      forward: state.forward,
      forwardBefore: state.forwardBefore,
    }]),
  );
}

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
 * How a model partition's commit changes the data catalog (swamp-club#3239):
 * the catalog actions a v2 repository takes for the same change, derived
 * from the commit's intents and data-version metadata. Pure: the read model
 * supplies each name's live versions and applies the actions.
 *
 * - A `data-version` op records a version: its row is upserted, unless it is
 *   a rename marker (`lifecycle: deleted` with `renamedTo`), which removes
 *   the old name's rows and forwards the name, as v2 `rename()` does.
 * - A versioned `data.delete` or `data.gc` tombstone removes that version's
 *   row, then the name is reconciled as v2 `delete(version)` and
 *   `collectGarbage` reconcile it: with no live version left the name is
 *   removed; with a rename marker on top it is removed and forwarded; else
 *   the greatest live version's row is upserted again, which restores a row
 *   an earlier rename removed.
 * - A version-less `data.gc` is expiry (v2 `removeLatestMarker`): the name's
 *   rows are removed while its versions stay. A version-less `data.delete`
 *   changes nothing: a delete of a whole name lists each version as its own
 *   tombstone.
 *
 * Names and versions come from intents and metadata, never from record keys.
 *
 * @module
 */

import type { DataMetadata } from "../data/data_metadata.ts";
import type { Op } from "./op.ts";

/** One live version of a data name, with the metadata its row is built from. */
export interface LiveDataVersion {
  readonly version: number;
  readonly metadata: DataMetadata;
}

/** One change to the data catalog, for one name of the commit's model. */
export type CatalogAction =
  /** Upsert this version's row; the catalog keeps the latest flags. */
  | { readonly kind: "upsert-version"; readonly metadata: DataMetadata }
  /** Remove one version's row. */
  | {
    readonly kind: "remove-version";
    readonly name: string;
    readonly version: number;
  }
  /** Remove every row of the name. */
  | { readonly kind: "remove-name"; readonly name: string }
  /** Record that the name forwards to `to`. */
  | { readonly kind: "forward"; readonly name: string; readonly to: string }
  /** Remove the name's forward, if any. */
  | { readonly kind: "end-forward"; readonly name: string };

/** What {@link projectCatalog} derived from one commit. */
export interface CatalogProjection {
  /** The catalog actions, in the order to apply them. */
  readonly actions: readonly CatalogAction[];
  /**
   * Each name the commit changed, with its live versions after the commit in
   * ascending order; an empty list when none is left.
   */
  readonly live: ReadonlyMap<string, readonly LiveDataVersion[]>;
}

/** True for a rename marker: the version v2 writes on a renamed name. */
export function isRenameMarker(metadata: DataMetadata): boolean {
  return metadata.lifecycle === "deleted" && metadata.renamedTo !== undefined;
}

/**
 * The catalog actions for one commit's ops, applied in order. `liveBefore`
 * returns a name's live versions before the commit. Ops that are not data
 * ops (a lease, a non-data put or tombstone) give no action.
 */
export function projectCatalog(
  ops: readonly Op[],
  liveBefore: (name: string) => readonly LiveDataVersion[],
): CatalogProjection {
  const live = new Map<string, Map<number, LiveDataVersion>>();
  const liveOf = (name: string): Map<number, LiveDataVersion> => {
    let versions = live.get(name);
    if (versions === undefined) {
      versions = new Map(liveBefore(name).map((v) => [v.version, v]));
      live.set(name, versions);
    }
    return versions;
  };
  const actions: CatalogAction[] = [];
  // Names to reconcile after the ops, in the order first touched.
  const reconcile = new Set<string>();

  for (const op of ops) {
    if (op.kind === "data-version") {
      const { metadata } = op;
      liveOf(metadata.name).set(metadata.version, {
        version: metadata.version,
        metadata,
      });
      if (isRenameMarker(metadata)) {
        actions.push(
          { kind: "remove-name", name: metadata.name },
          {
            kind: "forward",
            name: metadata.name,
            to: metadata.renamedTo as string,
          },
        );
      } else {
        actions.push({ kind: "upsert-version", metadata });
      }
    } else if (op.kind === "tombstone") {
      const intent = op.intent;
      if (intent.kind !== "data.delete" && intent.kind !== "data.gc") continue;
      if (intent.version !== undefined) {
        liveOf(intent.name).delete(intent.version);
        actions.push({
          kind: "remove-version",
          name: intent.name,
          version: intent.version,
        });
        reconcile.add(intent.name);
      } else if (intent.kind === "data.gc") {
        // Expiry after a versioned tombstone wins: v2 runs them as
        // delete(version) then removeLatestMarker. A later versioned
        // tombstone in the commit marks the name for reconcile again.
        reconcile.delete(intent.name);
        actions.push(
          { kind: "remove-name", name: intent.name },
          { kind: "end-forward", name: intent.name },
        );
      }
    }
  }

  for (const name of reconcile) {
    const top = greatest(liveOf(name));
    if (top === undefined) {
      actions.push(
        { kind: "remove-name", name },
        { kind: "end-forward", name },
      );
    } else if (isRenameMarker(top.metadata)) {
      actions.push(
        { kind: "remove-name", name },
        { kind: "forward", name, to: top.metadata.renamedTo as string },
      );
    } else {
      actions.push({ kind: "upsert-version", metadata: top.metadata });
    }
  }

  return {
    actions,
    live: new Map(
      [...live].map(([name, versions]) => [
        name,
        [...versions.values()].sort((a, b) => a.version - b.version),
      ]),
    ),
  };
}

function greatest(
  versions: ReadonlyMap<number, LiveDataVersion>,
): LiveDataVersion | undefined {
  let top: LiveDataVersion | undefined;
  for (const entry of versions.values()) {
    if (top === undefined || entry.version > top.version) top = entry;
  }
  return top;
}

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
 * names and versions come from intents and metadata, never record keys; a
 * version-less data.delete changes nothing since a whole-name delete lists each
 * version as its own tombstone
 */

import type { DataMetadata } from "../data/data_metadata.ts";
import type { Op } from "./op.ts";

export interface LiveDataVersion {
  readonly version: number;
  readonly metadata: DataMetadata;
}

export type CatalogAction =
  | { readonly kind: "upsert-version"; readonly metadata: DataMetadata }
  | {
    readonly kind: "remove-version";
    readonly name: string;
    readonly version: number;
  }
  | { readonly kind: "remove-name"; readonly name: string }
  | { readonly kind: "forward"; readonly name: string; readonly to: string }
  | { readonly kind: "end-forward"; readonly name: string };

/**
 * what a commit does to a name's live versions: a version put replaces any
 * live one of its number, and a removed version is never also put
 */
export interface LiveVersionChanges {
  readonly put: readonly LiveDataVersion[];
  readonly removed: readonly number[];
}

export interface CatalogProjection {
  readonly actions: readonly CatalogAction[];
  readonly versions: ReadonlyMap<string, LiveVersionChanges>;
}

export type GreatestLiveBefore = (
  name: string,
  excluding: ReadonlySet<number>,
) => LiveDataVersion | undefined;

export function isRenameMarker(metadata: DataMetadata): boolean {
  return metadata.lifecycle === "deleted" && metadata.renamedTo !== undefined;
}

export function greatestLiveIn(
  versionsOf: (name: string) => readonly LiveDataVersion[],
): GreatestLiveBefore {
  return (name, excluding) =>
    greatest(versionsOf(name).filter((v) => !excluding.has(v.version)));
}

export function liveAfter(
  before: readonly LiveDataVersion[],
  changes: LiveVersionChanges | undefined,
): LiveDataVersion[] {
  const live = new Map(before.map((v) => [v.version, v]));
  for (const version of changes?.removed ?? []) live.delete(version);
  for (const entry of changes?.put ?? []) live.set(entry.version, entry);
  return [...live.values()].sort((a, b) => a.version - b.version);
}

interface NameChanges {
  readonly put: Map<number, LiveDataVersion>;
  readonly removed: Set<number>;
}

/** reads only the greatest live version, and only of names it reconciles */
export function projectCatalog(
  ops: readonly Op[],
  greatestLiveBefore: GreatestLiveBefore,
): CatalogProjection {
  const changes = new Map<string, NameChanges>();
  const changesOf = (name: string): NameChanges => {
    let entry = changes.get(name);
    if (entry === undefined) {
      entry = { put: new Map(), removed: new Set() };
      changes.set(name, entry);
    }
    return entry;
  };
  const actions: CatalogAction[] = [];
  const reconcile = new Set<string>();

  for (const op of ops) {
    if (op.kind === "data-version") {
      const { metadata } = op;
      const entry = changesOf(metadata.name);
      entry.put.set(metadata.version, {
        version: metadata.version,
        metadata,
      });
      entry.removed.delete(metadata.version);
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
        const entry = changesOf(intent.name);
        entry.put.delete(intent.version);
        entry.removed.add(intent.version);
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
    const entry = changesOf(name);
    let top = greatestLiveBefore(name, entry.removed);
    // a version put in this commit replaces a stored one of its number
    const put = greatest([...entry.put.values()]);
    if (
      put !== undefined && (top === undefined || put.version >= top.version)
    ) {
      top = put;
    }
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
    versions: new Map(
      [...changes].map(([name, entry]) => [name, {
        put: [...entry.put.values()].sort((a, b) => a.version - b.version),
        removed: [...entry.removed].sort((a, b) => a - b),
      }]),
    ),
  };
}

function greatest(
  versions: Iterable<LiveDataVersion>,
): LiveDataVersion | undefined {
  let top: LiveDataVersion | undefined;
  for (const entry of versions) {
    if (top === undefined || entry.version > top.version) top = entry;
  }
  return top;
}

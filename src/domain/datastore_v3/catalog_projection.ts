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

export interface CatalogProjection {
  readonly actions: readonly CatalogAction[];
  readonly live: ReadonlyMap<string, readonly LiveDataVersion[]>;
}

export function isRenameMarker(metadata: DataMetadata): boolean {
  return metadata.lifecycle === "deleted" && metadata.renamedTo !== undefined;
}

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

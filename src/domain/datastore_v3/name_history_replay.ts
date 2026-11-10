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
 * exact because projectCatalog is per name: its change sets, reconcile set and
 * gc handling are keyed by name, so projecting a commit's ops filtered to some
 * names gives those names' actions of projecting all of them
 */

import {
  type CatalogAction,
  greatestLiveIn,
  liveAfter,
  type LiveDataVersion,
  projectCatalog,
} from "./catalog_projection.ts";
import type { Commit } from "./commit.ts";
import type { PartitionBase } from "./commit_store.ts";
import type { Op } from "./op.ts";
import { dataNameOfKey } from "./recovery_scope.ts";

export interface NameHistoryReplay {
  /** in the order a full rebuild applies them to these names */
  readonly actions: readonly CatalogAction[];
  readonly live: ReadonlyMap<string, readonly LiveDataVersion[]>;
  readonly commits: number;
}

/** the name a catalog-relevant op is about, or undefined for any other op */
export function catalogNameOfOp(op: Op): string | undefined {
  if (op.kind === "data-version") return op.metadata.name;
  if (op.kind === "tombstone") {
    const intent = op.intent;
    if (intent.kind === "data.delete" || intent.kind === "data.gc") {
      return intent.name;
    }
  }
  return undefined;
}

/**
 * the data names a commit's ops write, a put's by its key, as the rows a writer
 * stages for it are of these names
 */
export function catalogNamesOfCommit(commit: Commit): string[] {
  const names = new Set<string>();
  for (const op of commit.ops) {
    const name = catalogNameOfOp(op) ??
      (op.kind === "put" || op.kind === "tombstone"
        ? dataNameOfKey(op.key.toString())?.name
        : undefined);
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

/**
 * replays the names' history as a full rebuild does: the compacted base's
 * load, then each later commit's ops of those names; commits must be the
 * partition's after the base's compacted seq, in seq order
 */
export function catalogActionsForNames(
  base: PartitionBase,
  commits: readonly Commit[],
  names: ReadonlySet<string>,
): NameHistoryReplay {
  const actions: CatalogAction[] = [];
  const live = new Map<string, LiveDataVersion[]>();
  for (const name of [...names].sort()) live.set(name, []);
  for (
    const [name, state] of [...base.names].sort(([a], [b]) => compare(a, b))
  ) {
    if (!names.has(name)) continue;
    live.set(name, [...state.versions].sort((a, b) => a.version - b.version));
    actions.push(
      { kind: "remove-name", name },
      { kind: "end-forward", name },
    );
    for (
      const metadata of [...state.catalogRows].sort((a, b) =>
        a.version - b.version
      )
    ) {
      actions.push({ kind: "upsert-version", metadata });
    }
    if (state.forward !== undefined) {
      actions.push({ kind: "forward", name, to: state.forward });
    }
  }
  let replayed = 0;
  for (const commit of commits) {
    if (commit.seq <= base.compactedSeq) continue;
    const ops = commit.ops.filter((op) => {
      const name = catalogNameOfOp(op);
      return name !== undefined && names.has(name);
    });
    replayed++;
    if (ops.length === 0) continue;
    const projection = projectCatalog(
      ops,
      greatestLiveIn((name) => live.get(name) ?? []),
    );
    for (const action of projection.actions) actions.push(action);
    for (const [name, changes] of projection.versions) {
      live.set(name, liveAfter(live.get(name) ?? [], changes));
    }
  }
  return { actions, live, commits: replayed };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

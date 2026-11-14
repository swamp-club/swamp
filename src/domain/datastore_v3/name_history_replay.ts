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

import {
  type CatalogAction,
  type LiveDataVersion,
  LiveVersionIndex,
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
 * catalogNamesOfCommit read off a stored commit's JSON before it is decoded;
 * undefined when the JSON is not shaped as a commit, so the caller decodes it
 */
export function catalogNamesOfRawCommit(raw: unknown): string[] | undefined {
  const ops = (raw as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops)) return undefined;
  const names = new Set<string>();
  for (const op of ops) {
    if (typeof op !== "object" || op === null) return undefined;
    const { kind, key, intent, metadata } = op as Record<string, unknown>;
    let name: string | undefined;
    if (kind === "data-version") {
      name = (metadata as { name?: unknown } | undefined)?.name as
        | string
        | undefined;
      if (typeof name !== "string") return undefined;
    } else if (kind === "tombstone" || kind === "put") {
      const removal = intent as { kind?: unknown; name?: unknown } | undefined;
      if (
        kind === "tombstone" &&
        (removal?.kind === "data.delete" || removal?.kind === "data.gc")
      ) {
        if (typeof removal.name !== "string") return undefined;
        name = removal.name;
      } else {
        if (typeof key !== "string") return undefined;
        name = dataNameOfKey(key)?.name;
      }
    } else if (typeof kind !== "string") {
      return undefined;
    }
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

/**
 * replays the names' history as a full rebuild does, exact since projectCatalog
 * keys every change by name; commits are the partition's after the base's
 * compacted seq, in seq order
 */
export function catalogActionsForNames(
  base: PartitionBase,
  commits: readonly Commit[],
  names: ReadonlySet<string>,
): NameHistoryReplay {
  const actions: CatalogAction[] = [];
  const live = new Map<string, LiveVersionIndex>();
  for (const name of [...names].sort()) live.set(name, new LiveVersionIndex());
  for (
    const [name, state] of [...base.names].sort(([a], [b]) => compare(a, b))
  ) {
    if (!names.has(name)) continue;
    live.set(name, new LiveVersionIndex(state.versions));
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
      (name, excluding) => live.get(name)?.greatestExcluding(excluding),
    );
    for (const action of projection.actions) actions.push(action);
    for (const [name, changes] of projection.versions) {
      let index = live.get(name);
      if (index === undefined) {
        index = new LiveVersionIndex();
        live.set(name, index);
      }
      index.apply(changes);
    }
  }
  const versions = new Map<string, LiveDataVersion[]>();
  for (const [name, index] of live) versions.set(name, index.toArray());
  return { actions, live: versions, commits: replayed };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

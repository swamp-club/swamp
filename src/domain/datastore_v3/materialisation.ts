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

import type { Commit } from "./commit.ts";
import type { PutOp } from "./op.ts";
import type { RecordKey } from "./record_key.ts";

export interface KeyChange {
  readonly key: RecordKey;
  readonly put: PutOp | null;
}

/**
 * removals come first, in first-touched order, then writes: a removal can only
 * clear the way for a write (a put of data/x needs a removed data/x/y's
 * directory gone)
 */
export function finalKeyStates(commit: Commit): KeyChange[] {
  const changes = new Map<string, KeyChange>();
  for (const op of commit.ops) {
    if (op.kind === "put" || op.kind === "tombstone") {
      // A Map keeps each key at its first insertion, whatever is set later.
      const key = op.key.toString();
      const put = op.kind === "put" ? op : null;
      changes.set(key, { key: op.key, put });
    }
  }
  const all = [...changes.values()];
  return [
    ...all.filter((change) => change.put === null),
    ...all.filter((change) => change.put !== null),
  ];
}

/**
 * one record key can be written by two partitions and a catch-up applies
 * commits ahead of the feed, so the file follows feed positions rather than
 * application order
 */
export interface FileOwnership {
  readonly owner: string;
  readonly mark: number;
  readonly present: boolean;
}

export type FileDecision =
  | { readonly kind: "keep" }
  | { readonly kind: "remove"; readonly next: FileOwnership | undefined }
  | { readonly kind: "write"; readonly next: FileOwnership };

/**
 * a tombstone keeps the mark so an older put of another partition cannot bring
 * the file back; a key with no ownership is removed
 */
export function decideFile(
  before: FileOwnership | undefined,
  owner: string,
  position: number,
  isPut: boolean,
): FileDecision {
  if (!isPut) {
    if (before !== undefined && !(before.present && before.owner === owner)) {
      return { kind: "keep" };
    }
    return {
      kind: "remove",
      next: before === undefined ? undefined : { ...before, present: false },
    };
  }
  if (before !== undefined && position <= before.mark) return { kind: "keep" };
  return { kind: "write", next: { owner, mark: position, present: true } };
}

const CATALOG_DATABASE = /^_catalog.*\.db(?:-wal|-shm|-journal)?$/i;

/**
 * the read model also refuses keys that resolve into its state directory, which
 * needs a path
 */
export function lexicalRefusal(
  key: string,
  subdirs: ReadonlySet<string>,
): string | undefined {
  const segments = key.split("/");
  if (!subdirs.has(segments[0])) {
    return `its first segment ${
      segments[0]
    } is not a datastore-synced directory`;
  }
  if (CATALOG_DATABASE.test(segments[segments.length - 1])) {
    return "it names a catalog database";
  }
  return undefined;
}

/**
 * on a cache holding only materialised files this is what the read model finds
 * on disk, since directories exist only above present files
 */
export function lexicalConflict(
  key: string,
  isPresentFile: (key: string) => boolean,
  hasPresentFileUnder: (key: string) => boolean,
): "under-file" | "directory" | undefined {
  const segments = key.split("/");
  for (let i = 1; i < segments.length; i++) {
    if (isPresentFile(segments.slice(0, i).join("/"))) return "under-file";
  }
  return hasPresentFileUnder(key) ? "directory" : undefined;
}

export interface NetReplayCommit {
  readonly namespace: string;
  readonly partition: string;
  readonly position: number;
  readonly changes: readonly KeyChange[];
}

export interface NetReplayPlan {
  readonly bound: number;
  skipsWrite(namespace: string, key: string, position: number): boolean;
  skipsRemoval(namespace: string, key: string, position: number): boolean;
  readonly replaceable: number;
  readonly keptForPrefix: number;
  readonly keptForDirectory: number;
}

/**
 * a key skips writes only if no other key is its path prefix, so its file never
 * decides another key's conflict; keys compare case-folded and NFC, as
 * case-insensitive or normalising filesystems do
 */
export class NetReplayPlanner {
  readonly #ownership = new Map<string, FileOwnership>();
  readonly #writes = new Map<string, number[]>();
  readonly #keys = new Map<string, Set<string>>();
  #bound = 0;

  constructor(
    readonly ignored: (namespace: string, key: string) => boolean,
  ) {}

  /**
   * the key starts from the base's ownership, as the replay after the base load
   * does, and a present file counts as a write at its mark that a later tail
   * commit may replace or remove
   */
  seed(namespace: string, key: string, ownership: FileOwnership): void {
    if (this.ignored(namespace, key)) return;
    const keys = this.#keys.get(namespace) ?? new Set<string>();
    keys.add(key);
    this.#keys.set(namespace, keys);
    const id = idOf(namespace, key);
    this.#ownership.set(id, ownership);
    if (ownership.present) {
      const writes = this.#writes.get(id) ?? [];
      writes.push(ownership.mark);
      this.#writes.set(id, writes);
    }
  }

  add(commit: NetReplayCommit): void {
    this.#bound = Math.max(this.#bound, commit.position);
    for (const change of commit.changes) {
      const key = change.key.toString();
      if (this.ignored(commit.namespace, key)) continue;
      const keys = this.#keys.get(commit.namespace) ?? new Set<string>();
      keys.add(key);
      this.#keys.set(commit.namespace, keys);
      const id = idOf(commit.namespace, key);
      const decision = decideFile(
        this.#ownership.get(id),
        commit.partition,
        commit.position,
        change.put !== null,
      );
      if (decision.kind === "keep") continue;
      if (decision.next !== undefined) this.#ownership.set(id, decision.next);
      if (decision.kind === "write") {
        const writes = this.#writes.get(id) ?? [];
        writes.push(commit.position);
        this.#writes.set(id, writes);
      }
    }
  }

  directories(): { namespace: string; segment: string }[] {
    const found: { namespace: string; segment: string }[] = [];
    for (const [namespace, keys] of this.#keys) {
      const segments = new Set([...keys].map((key) => key.split("/")[0]));
      for (const segment of segments) found.push({ namespace, segment });
    }
    return found;
  }

  finish(
    directoryAbsent: (namespace: string, segment: string) => boolean,
  ): NetReplayPlan {
    const prefixed = new Set<string>();
    for (const [namespace, keys] of this.#keys) {
      const folded = new Map<string, string[]>();
      for (const key of keys) {
        const spelling = foldKey(key);
        folded.set(spelling, [...(folded.get(spelling) ?? []), key]);
      }
      for (const same of folded.values()) {
        if (same.length < 2) continue;
        for (const key of same) prefixed.add(idOf(namespace, key));
      }
      for (const key of keys) {
        const segments = foldKey(key).split("/");
        for (let i = 1; i < segments.length; i++) {
          const prefixes = folded.get(segments.slice(0, i).join("/"));
          if (prefixes === undefined) continue;
          for (const prefix of prefixes) prefixed.add(idOf(namespace, prefix));
          prefixed.add(idOf(namespace, key));
        }
      }
    }
    const eligible = new Set<string>();
    const skipped = new Set<string>();
    let replaceable = 0;
    let keptForPrefix = 0;
    let keptForDirectory = 0;
    for (const [id, writes] of this.#writes) {
      const own = this.#ownership.get(id);
      const final = own?.present === true ? own.mark : undefined;
      const replaced = writes.filter((position) => position !== final);
      replaceable += replaced.length;
      const [namespace, key] = splitId(id);
      if (prefixed.has(id)) {
        keptForPrefix += replaced.length;
        continue;
      }
      if (!directoryAbsent(namespace, key.split("/")[0])) {
        keptForDirectory += replaced.length;
        continue;
      }
      eligible.add(id);
      for (const position of replaced) skipped.add(`${id}\0${position}`);
    }
    // A key only ever removed is eligible as well: nothing of it is on disk.
    for (const [namespace, keys] of this.#keys) {
      for (const key of keys) {
        const id = idOf(namespace, key);
        if (this.#writes.has(id) || prefixed.has(id)) continue;
        if (directoryAbsent(namespace, key.split("/")[0])) eligible.add(id);
      }
    }
    const bound = this.#bound;
    return {
      bound,
      skipsWrite: (namespace, key, position) =>
        position <= bound &&
        skipped.has(`${idOf(namespace, key)}\0${position}`),
      skipsRemoval: (namespace, key, position) =>
        position <= bound && eligible.has(idOf(namespace, key)),
      replaceable,
      keptForPrefix,
      keptForDirectory,
    };
  }
}

function foldKey(key: string): string {
  return key.normalize("NFC").toLowerCase();
}

function idOf(namespace: string, key: string): string {
  return `${namespace}\0${key}`;
}

function splitId(id: string): [string, string] {
  const at = id.indexOf("\0");
  return [id.slice(0, at), id.slice(at + 1)];
}

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
 * The rules that decide what a commit does to the materialised files, shared
 * by the v3 read model (swamp-club#3239), which applies them to one
 * checkout's files, and history compaction (swamp-club#3258), which folds
 * them into the compacted base. One copy, so a checkout that loads the base
 * ends where a full replay would.
 *
 * - **Final key states.** Ops in one commit see each other's effects, so
 *   only each key's last put or tombstone is materialised, removals first.
 * - **File ownership (swamp-club#3256).** A file follows the change feed,
 *   not the order commits are applied in: a put writes only when it is newer
 *   in the feed than the put the file shows, and a tombstone removes the
 *   file only while it shows the tombstoning partition's own put.
 * - **Lexical keys.** Which keys may be materialised, and the file and
 *   directory conflicts a key meets among the present files, decided from
 *   key strings alone.
 *
 * @module
 */

import type { Commit } from "./commit.ts";
import type { PutOp } from "./op.ts";
import type { RecordKey } from "./record_key.ts";

/** A key's final state in one commit: the put that leaves it, or null. */
export interface KeyChange {
  readonly key: RecordKey;
  readonly put: PutOp | null;
}

/**
 * Each key a commit touches, with the op that leaves it: ops in one commit
 * see each other's effects, so only the last put or tombstone of a key
 * matters. Removals come first, in first-touched order, then writes: each
 * key's final state is settled, so the order only decides the filesystem
 * path a write meets, and a removal can only clear the way for a write
 * (a put of `data/x` needs a removed `data/x/y`'s directory gone).
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
 * Which put a materialised file shows (swamp-club#3256). One record key can
 * be written by two partitions (a same-key definition rename), and a
 * partition catch-up applies commits ahead of the change feed, so the file
 * follows feed positions rather than application order.
 */
export interface FileOwnership {
  /** The partition whose put the file shows, or showed before its removal. */
  readonly owner: string;
  /** The feed position of that put. */
  readonly mark: number;
  /** False once the owner's own tombstone removed the file. */
  readonly present: boolean;
}

/** What one key change does to its file. */
export type FileDecision =
  /** Leave the file and its ownership alone. */
  | { readonly kind: "keep" }
  /** Remove the file; record `next` as its ownership, when defined. */
  | { readonly kind: "remove"; readonly next: FileOwnership | undefined }
  /** Write the put's content; record `next` as its ownership. */
  | { readonly kind: "write"; readonly next: FileOwnership };

/**
 * The file decision for a put (or, with `isPut` false, a tombstone) of
 * `owner`'s partition at feed position `position`, given the file's ownership
 * before the commit. A put writes only when the key has no ownership or its
 * position is greater than the mark, then becomes the owner. A tombstone
 * removes the file only while it is present and owned by `owner`, and keeps
 * the mark, so an older put of another partition cannot bring it back. A key
 * with no ownership is removed (no put of it was applied, or it is a name
 * directory).
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

/** A catalog database or one of its SQLite side files. */
const CATALOG_DATABASE = /^_catalog.*\.db(?:-wal|-shm|-journal)?$/i;

/**
 * Why a key must never be materialised, judged from the key alone; undefined
 * when its string is acceptable. Its first segment must be a synced
 * subdirectory (one of `subdirs`) and it must not name a catalog database.
 * The read model also refuses keys that resolve into its state directory,
 * which needs a path.
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
 * A file and a directory claiming one key, among a set of present files:
 * `under-file` when an ancestor of the key is a present file, `directory`
 * when a present file lies under the key. Undefined when there is neither.
 * On a cache holding only materialised files this is what the read model
 * finds on disk, since directories exist only above present files.
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

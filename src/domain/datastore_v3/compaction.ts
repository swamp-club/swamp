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
 * History compaction (swamp-club#3258): every commit at or below a
 * store-wide compaction point is folded into a compacted base and deleted,
 * so chunks that only superseded commits named can be reclaimed. Dormant:
 * nothing in production compacts until the v3 opt-in wires it in.
 *
 * - **The compacted base** is what a checkout would hold after applying
 *   every compacted commit: each partition's present records (digest and
 *   inline content or `BlobRef`), its live data versions, each data name's
 *   catalog rows and forward, each materialised key's ownership, and each
 *   partition's compacted seq.
 * - **One fold.** {@link foldCommit} applies a commit to the base with the
 *   read model's own rules (`materialisation.ts`, `projectCatalog`,
 *   `catalog_state.ts`), so a checkout that loads the base and replays the
 *   commits after the point ends where a full replay would.
 * - **Store-wide**, not per partition: the read model catches up through the
 *   store-wide feed, and file ownership marks (swamp-club#3256) compare feed
 *   positions across partitions. With no commit at or below the point left,
 *   every later put is newer in the feed than every mark in the base.
 *
 * See "v3 history compaction" in `design/enablers/datastores.md`.
 *
 * @module
 */

import type { BlobRef } from "./blob_ref.ts";
import { type LiveDataVersion, projectCatalog } from "./catalog_projection.ts";
import { type CatalogNameState, foldCatalogActions } from "./catalog_state.ts";
import type { Commit } from "./commit.ts";
import type { FileAccess } from "./file_access.ts";
import {
  decideFile,
  type FileOwnership,
  finalKeyStates,
  lexicalConflict,
  lexicalRefusal,
} from "./materialisation.ts";

/** A present record in the compacted base. */
export interface BaseRecord {
  /** The SHA-256 of the record's bytes. */
  readonly sha256: string;
  /** The record's content: inline base64, or the blob its chunks form. */
  readonly content:
    | { readonly inline: string }
    | { readonly blob: BlobRef };
  /** The put's file access (swamp-club#3693); undefined for a plain file. */
  readonly access?: FileAccess;
}

/**
 * The compacted base, as {@link foldCommit} reads and writes it. The commit
 * store implements it over its own tables inside the compaction's
 * transaction, so it is synchronous. Partitions and keys are strings, the
 * forms the store keys its rows by; namespace `""` is the unnamespaced
 * datastore.
 */
export interface CompactedBaseWriter {
  /** Records `key` as present in the partition with this content. */
  putRecord(
    namespace: string,
    partition: string,
    key: string,
    record: BaseRecord,
  ): void;
  /** Removes `key` from the partition's present records, if there. */
  deleteRecord(namespace: string, partition: string, key: string): void;
  /** A data name's live versions, in ascending order. */
  liveVersions(
    namespace: string,
    partition: string,
    name: string,
  ): readonly LiveDataVersion[];
  /** Replaces a data name's live versions; an empty list removes them. */
  setLiveVersions(
    namespace: string,
    partition: string,
    name: string,
    versions: readonly LiveDataVersion[],
  ): void;
  /** A data name's catalog rows and forward. */
  catalogName(
    namespace: string,
    partition: string,
    name: string,
  ): CatalogNameState;
  /** Replaces a data name's catalog rows and forward. */
  setCatalogName(
    namespace: string,
    partition: string,
    name: string,
    state: CatalogNameState,
  ): void;
  /** Which put a materialised key shows; undefined when none was applied. */
  fileOwnership(namespace: string, key: string): FileOwnership | undefined;
  /** Records a key's new ownership. */
  setFileOwnership(
    namespace: string,
    key: string,
    ownership: FileOwnership,
  ): void;
  /** True when a present file lies under `key/`. */
  hasPresentFileUnder(namespace: string, key: string): boolean;
  /** Records the partition's last compacted seq. */
  setCompactedSeq(namespace: string, partition: string, seq: number): void;
}

/**
 * Folds one commit, at feed position `position`, into the base: what the
 * read model does to a checkout when it applies the commit to a cache that
 * holds only materialised files.
 *
 * - Every touched key's record is put or removed, refused and conflicting
 *   keys included: the read model indexes them too.
 * - A key is materialised only when its string is acceptable
 *   (`lexicalRefusal` against `subdirs`, the synced subdirectories) and it
 *   meets no file or directory conflict among the base's present files;
 *   then the ownership rule decides.
 * - Live versions and catalog rows follow `projectCatalog`.
 *
 * Commits must be folded in feed order, each once.
 */
export function foldCommit(
  base: CompactedBaseWriter,
  commit: Commit,
  position: number,
  subdirs: ReadonlySet<string>,
): void {
  const namespace = commit.namespace;
  const partition = commit.partition.toString();
  const ownership = (key: string) => base.fileOwnership(namespace, key);
  for (const change of finalKeyStates(commit)) {
    const key = change.key.toString();
    if (change.put === null) {
      base.deleteRecord(namespace, partition, key);
    } else {
      base.putRecord(namespace, partition, key, {
        sha256: change.put.sha256,
        content: change.put.content,
        ...(change.put.access === undefined
          ? {}
          : { access: change.put.access }),
      });
    }
    if (lexicalRefusal(key, subdirs) !== undefined) continue;
    const conflict = lexicalConflict(
      key,
      (k) => ownership(k)?.present === true,
      (k) => base.hasPresentFileUnder(namespace, k),
    );
    // A put meeting either conflict is skipped; under a file, a tombstone
    // has nothing to remove; a tombstone of a directory goes on, as the read
    // model's does.
    if (conflict === "under-file") continue;
    if (conflict === "directory" && change.put !== null) continue;
    const decision = decideFile(
      ownership(key),
      partition,
      position,
      change.put !== null,
    );
    if (decision.kind !== "keep" && decision.next !== undefined) {
      base.setFileOwnership(namespace, key, decision.next);
    }
  }
  const projection = projectCatalog(
    commit.ops,
    (name) => base.liveVersions(namespace, partition, name),
  );
  // Read every name's catalog state as it was before the commit, then write
  // the live versions, then the catalog: a store may keep catalog rows as
  // references to live versions.
  const catalog = foldCatalogActions(
    projection.actions,
    (name) => base.catalogName(namespace, partition, name),
  );
  for (const [name, versions] of projection.live) {
    base.setLiveVersions(namespace, partition, name, versions);
  }
  for (const [name, state] of catalog) {
    base.setCatalogName(namespace, partition, name, state);
  }
  base.setCompactedSeq(namespace, partition, commit.seq);
}

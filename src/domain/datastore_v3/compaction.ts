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

import type { BlobRef } from "./blob_ref.ts";
import {
  type LiveDataVersion,
  type LiveVersionChanges,
  projectCatalog,
} from "./catalog_projection.ts";
import { type CatalogNameChange, foldCatalogChanges } from "./catalog_state.ts";
import type { Commit } from "./commit.ts";
import type { FileAccess } from "./file_access.ts";
import {
  decideFile,
  type FileOwnership,
  finalKeyStates,
  lexicalConflict,
  lexicalRefusal,
} from "./materialisation.ts";

export interface BaseRecord {
  readonly sha256: string;
  readonly content:
    | { readonly inline: string }
    | { readonly blob: BlobRef };
  readonly access?: FileAccess;
}

/**
 * synchronous because the commit store implements it over its own tables inside
 * the compaction's transaction; namespace "" is the unnamespaced datastore
 */
export interface CompactedBaseWriter {
  /** the commit the writes until the next call belong to */
  atCommit(namespace: string, partition: string, seq: number): void;
  putRecord(
    namespace: string,
    partition: string,
    key: string,
    record: BaseRecord,
  ): void;
  deleteRecord(namespace: string, partition: string, key: string): void;
  greatestLiveVersion(
    namespace: string,
    partition: string,
    name: string,
    excluding: ReadonlySet<number>,
  ): LiveDataVersion | undefined;
  applyLiveVersions(
    namespace: string,
    partition: string,
    name: string,
    changes: LiveVersionChanges,
  ): void;
  greatestCatalogRow(
    namespace: string,
    partition: string,
    name: string,
    excluding: ReadonlySet<number>,
  ): number | undefined;
  catalogRow(
    namespace: string,
    partition: string,
    name: string,
    version: number,
  ): LiveDataVersion["metadata"] | undefined;
  catalogForward(
    namespace: string,
    partition: string,
    name: string,
  ): string | undefined;
  /** after the commit's live versions, so its rows can be checked against them */
  applyCatalogChange(
    namespace: string,
    partition: string,
    name: string,
    change: CatalogNameChange,
  ): void;
  fileOwnership(namespace: string, key: string): FileOwnership | undefined;
  setFileOwnership(
    namespace: string,
    key: string,
    ownership: FileOwnership,
  ): void;
  hasPresentFileUnder(namespace: string, key: string): boolean;
  setCompactedSeq(namespace: string, partition: string, seq: number): void;
}

/**
 * commits must be folded in feed order, each once; a fold reads and writes only
 * the rows its commit changes, so its cost never grows with a name's history
 */
export function foldCommit(
  base: CompactedBaseWriter,
  commit: Commit,
  position: number,
  subdirs: ReadonlySet<string>,
): void {
  const namespace = commit.namespace;
  const partition = commit.partition.toString();
  base.atCommit(namespace, partition, commit.seq);
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
    (name, excluding) =>
      base.greatestLiveVersion(namespace, partition, name, excluding),
  );
  // Read every name's catalog rows as they were before the commit, then write
  // the live versions, then the catalog: a store may keep catalog rows as
  // references to live versions.
  const catalog = foldCatalogChanges(projection.actions, {
    greatestRow: (name, excluding) =>
      base.greatestCatalogRow(namespace, partition, name, excluding),
    row: (name, version) =>
      base.catalogRow(namespace, partition, name, version),
    forward: (name) => base.catalogForward(namespace, partition, name),
  });
  for (const [name, changes] of projection.versions) {
    base.applyLiveVersions(namespace, partition, name, changes);
  }
  for (const [name, change] of catalog) {
    base.applyCatalogChange(namespace, partition, name, change);
  }
  base.setCompactedSeq(namespace, partition, commit.seq);
}

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
  greatestLiveIn,
  liveAfter,
  type LiveDataVersion,
  projectCatalog,
} from "./catalog_projection.ts";
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
  putRecord(
    namespace: string,
    partition: string,
    key: string,
    record: BaseRecord,
  ): void;
  deleteRecord(namespace: string, partition: string, key: string): void;
  liveVersions(
    namespace: string,
    partition: string,
    name: string,
  ): readonly LiveDataVersion[];
  setLiveVersions(
    namespace: string,
    partition: string,
    name: string,
    versions: readonly LiveDataVersion[],
  ): void;
  catalogName(
    namespace: string,
    partition: string,
    name: string,
  ): CatalogNameState;
  setCatalogName(
    namespace: string,
    partition: string,
    name: string,
    state: CatalogNameState,
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

/** commits must be folded in feed order, each once */
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
  const versionsOf = (name: string) =>
    base.liveVersions(namespace, partition, name);
  const projection = projectCatalog(commit.ops, greatestLiveIn(versionsOf));
  // Read every name's catalog state as it was before the commit, then write
  // the live versions, then the catalog: a store may keep catalog rows as
  // references to live versions.
  const catalog = foldCatalogActions(
    projection.actions,
    (name) => base.catalogName(namespace, partition, name),
  );
  for (const [name, changes] of projection.versions) {
    base.setLiveVersions(
      namespace,
      partition,
      name,
      liveAfter(versionsOf(name), changes),
    );
  }
  for (const [name, state] of catalog) {
    base.setCatalogName(namespace, partition, name, state);
  }
  base.setCompactedSeq(namespace, partition, commit.seq);
}

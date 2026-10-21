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

import { assertEquals } from "@std/assert";
import type { LiveDataVersion } from "./catalog_projection.ts";
import { type CatalogNameState, EMPTY_CATALOG_NAME } from "./catalog_state.ts";
import {
  type BaseRecord,
  type CompactedBaseWriter,
  foldCommit,
} from "./compaction.ts";
import type { FileOwnership } from "./materialisation.ts";
import { type Op, putOp, tombstoneOp } from "./op.ts";
import { partitionOf } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";
import {
  base64,
  dataKey,
  deleteVersion,
  modelCommit,
  modelIntent,
  modelPartition,
  savePut,
  versionOp,
} from "./v3_test_helpers.ts";

const SUBDIRS = new Set(["data", "definitions"]);
const MODEL = modelPartition().toString();

/** The compacted base as plain maps. */
class MemoryBase implements CompactedBaseWriter {
  readonly records = new Map<string, BaseRecord>();
  readonly versions = new Map<string, readonly LiveDataVersion[]>();
  readonly catalog = new Map<string, CatalogNameState>();
  readonly files = new Map<string, FileOwnership>();
  readonly seqs = new Map<string, number>();

  putRecord(ns: string, p: string, key: string, record: BaseRecord): void {
    this.records.set(`${ns}|${p}|${key}`, record);
  }
  deleteRecord(ns: string, p: string, key: string): void {
    this.records.delete(`${ns}|${p}|${key}`);
  }
  liveVersions(ns: string, p: string, name: string) {
    return this.versions.get(`${ns}|${p}|${name}`) ?? [];
  }
  setLiveVersions(
    ns: string,
    p: string,
    name: string,
    versions: readonly LiveDataVersion[],
  ): void {
    if (versions.length === 0) this.versions.delete(`${ns}|${p}|${name}`);
    else this.versions.set(`${ns}|${p}|${name}`, versions);
  }
  catalogName(ns: string, p: string, name: string): CatalogNameState {
    return this.catalog.get(`${ns}|${p}|${name}`) ?? EMPTY_CATALOG_NAME;
  }
  setCatalogName(ns: string, p: string, name: string, state: CatalogNameState) {
    this.catalog.set(`${ns}|${p}|${name}`, state);
  }
  fileOwnership(ns: string, key: string) {
    return this.files.get(`${ns}|${key}`);
  }
  setFileOwnership(ns: string, key: string, ownership: FileOwnership): void {
    this.files.set(`${ns}|${key}`, ownership);
  }
  hasPresentFileUnder(ns: string, key: string): boolean {
    return [...this.files].some(([k, f]) =>
      f.present && k.startsWith(`${ns}|${key}/`)
    );
  }
  setCompactedSeq(ns: string, p: string, seq: number): void {
    this.seqs.set(`${ns}|${p}`, seq);
  }
}

Deno.test("foldCommit: a save and a later delete leave the base a replay would", async () => {
  const base = new MemoryBase();
  const save = await savePut("a", 1);
  foldCommit(base, modelCommit(1, [save, versionOp("a", 1)]), 10, SUBDIRS);
  const key = dataKey("a", 1).toString();
  assertEquals(base.records.get(`|${MODEL}|${key}`), {
    sha256: save.sha256,
    content: save.content,
  });
  assertEquals(base.files.get(`|${key}`), {
    owner: MODEL,
    mark: 10,
    present: true,
  });
  assertEquals(base.liveVersions("", MODEL, "a").map((v) => v.version), [1]);
  assertEquals(base.catalogName("", MODEL, "a").rows.length, 1);
  assertEquals(base.seqs.get(`|${MODEL}`), 1);

  foldCommit(base, modelCommit(2, [deleteVersion("a", 1)]), 12, SUBDIRS);
  assertEquals(base.records.size, 0);
  assertEquals(base.files.get(`|${key}`), {
    owner: MODEL,
    mark: 10,
    present: false,
  });
  assertEquals(base.liveVersions("", MODEL, "a"), []);
  assertEquals(base.catalogName("", MODEL, "a"), EMPTY_CATALOG_NAME);
  assertEquals(base.seqs.get(`|${MODEL}`), 2);
});

Deno.test("foldCommit: the base keeps a put's file access (swamp-club#3693)", async () => {
  const base = new MemoryBase();
  const plain = await savePut("a", 1);
  const executable = await putOp({
    intent: plain.intent,
    key: plain.key,
    inline: (plain.content as { inline: string }).inline,
    access: "executable",
  });
  foldCommit(base, modelCommit(1, [executable]), 10, SUBDIRS);
  const key = `|${MODEL}|${dataKey("a", 1)}`;
  assertEquals(base.records.get(key), {
    sha256: plain.sha256,
    content: plain.content,
    access: "executable",
  });
  // A later plain put of the key leaves a plain record.
  foldCommit(base, modelCommit(2, [plain]), 11, SUBDIRS);
  assertEquals(base.records.get(key), {
    sha256: plain.sha256,
    content: plain.content,
  });
});

Deno.test("foldCommit: a refused key and a put under a file are indexed but never materialised", async () => {
  const base = new MemoryBase();
  const refused = await putOp({
    intent: modelIntent({ kind: "data.save", name: "a", version: 1 }),
    key: RecordKey.create("secrets/x"),
    inline: base64("x"),
  });
  const file = await putOp({
    intent: modelIntent({ kind: "data.save", name: "a", version: 1 }),
    key: RecordKey.create("data/x"),
    inline: base64("x"),
  });
  const under = await putOp({
    intent: modelIntent({ kind: "data.save", name: "a", version: 1 }),
    key: RecordKey.create("data/x/y"),
    inline: base64("y"),
  });
  foldCommit(base, modelCommit(1, [refused, file]), 1, SUBDIRS);
  foldCommit(base, modelCommit(2, [under]), 2, SUBDIRS);
  assertEquals(
    [...base.records.keys()].sort(),
    [`|${MODEL}|data/x`, `|${MODEL}|data/x/y`, `|${MODEL}|secrets/x`],
  );
  assertEquals([...base.files.keys()], ["|data/x"]);
  // A put at a directory holding a present file is skipped too.
  const dir = await putOp({
    intent: modelIntent({ kind: "data.save", name: "a", version: 1 }),
    key: RecordKey.create("data"),
    inline: base64("d"),
  });
  foldCommit(base, modelCommit(3, [dir]), 3, SUBDIRS);
  assertEquals([...base.files.keys()], ["|data/x"]);
});

Deno.test("foldCommit: a key two partitions write follows the feed (swamp-club#3256)", async () => {
  const base = new MemoryBase();
  const key = RecordKey.create("definitions/shared.yaml");
  const partitionOfName = (name: string) =>
    partitionOf({ kind: "config", definitionKind: "model", name });
  const put = (name: string, text: string) =>
    putOp({
      intent: { kind: "definition.edit", definition: { kind: "model", name } },
      key,
      inline: base64(text),
    });
  const remove = (name: string) =>
    tombstoneOp({
      intent: {
        kind: "definition.delete",
        definition: { kind: "model", name },
      },
      key,
    });
  const commit = (name: string, seq: number, ops: readonly Op[]) =>
    modelCommit(seq, ops, { partition: partitionOfName(name) });

  foldCommit(base, commit("old", 1, [await put("old", "v1")]), 1, SUBDIRS);
  foldCommit(base, commit("new", 1, [await put("new", "v2")]), 2, SUBDIRS);
  // The old name's tombstone does not remove the new name's file.
  foldCommit(base, commit("old", 2, [remove("old")]), 3, SUBDIRS);
  assertEquals(base.files.get(`|${key}`), {
    owner: partitionOfName("new").toString(),
    mark: 2,
    present: true,
  });
  assertEquals(
    base.records.has(`|${partitionOfName("old")}|${key}`),
    false,
  );
});

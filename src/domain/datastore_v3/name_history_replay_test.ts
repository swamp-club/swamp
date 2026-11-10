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
import { DataMetadataSchema } from "../data/data_metadata.ts";
import {
  catalogActionsForNames,
  catalogNamesOfCommit,
} from "./name_history_replay.ts";
import { tombstoneOp } from "./op.ts";
import { RecordKey } from "./record_key.ts";
import {
  deleteVersion,
  metadata,
  MODEL_ID,
  MODEL_TYPE,
  modelCommit,
  modelIntent,
  savePut,
  versionOp,
} from "./v3_test_helpers.ts";

function meta(name: string, version: number) {
  return DataMetadataSchema.parse(metadata(name, version));
}

Deno.test("catalogActionsForNames: a name's base rows load as a full rebuild loads them, and a later expiry removes the name", () => {
  const base = {
    compactedSeq: 2,
    names: new Map([
      ["a", {
        versions: [{ version: 1, metadata: meta("a", 1) }],
        catalogRows: [meta("a", 1)],
        forward: undefined,
      }],
      ["b", {
        versions: [{ version: 1, metadata: meta("b", 1) }],
        catalogRows: [meta("b", 1)],
        forward: "c",
      }],
    ]),
  };
  const expiry = modelCommit(3, [
    tombstoneOp({
      intent: modelIntent({ kind: "data.gc", name: "a" }),
      key: RecordKey.create(
        `data/${MODEL_TYPE.normalized}/${MODEL_ID}/a/latest`,
      ),
    }),
  ]);
  const replay = catalogActionsForNames(base, [expiry], new Set(["a"]));
  assertEquals(replay.actions, [
    { kind: "remove-name", name: "a" },
    { kind: "end-forward", name: "a" },
    { kind: "upsert-version", metadata: meta("a", 1) },
    { kind: "remove-name", name: "a" },
    { kind: "end-forward", name: "a" },
  ]);
  assertEquals(replay.live.get("a")?.map((v) => v.version), [1]);
  assertEquals(replay.commits, 1);
});

Deno.test("catalogActionsForNames: a name the base does not hold starts with no live versions, and a delete reconciles from the replayed ones", async () => {
  const commits = [
    modelCommit(1, [await savePut("a", 1), versionOp("a", 1)]),
    modelCommit(2, [await savePut("a", 2), versionOp("a", 2)]),
    modelCommit(3, [deleteVersion("a", 2)]),
  ];
  const replay = catalogActionsForNames(
    { compactedSeq: 0, names: new Map() },
    commits,
    new Set(["a"]),
  );
  assertEquals(replay.actions.at(-1), {
    kind: "upsert-version",
    metadata: meta("a", 1),
  });
  assertEquals(replay.live.get("a")?.map((v) => v.version), [1]);
});

Deno.test("catalogNamesOfCommit: names a commit's versions, tombstones and puts write", async () => {
  const commit = modelCommit(1, [
    await savePut("a", 1),
    versionOp("b", 1),
    deleteVersion("c", 1),
  ]);
  assertEquals(catalogNamesOfCommit(commit), ["a", "b", "c"]);
});

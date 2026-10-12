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
import {
  decideFile,
  finalKeyStates,
  lexicalConflict,
  lexicalRefusal,
} from "./materialisation.ts";
import {
  dataKey,
  deleteVersion,
  modelCommit,
  savePut,
  versionOp,
} from "./v3_test_helpers.ts";

const SUBDIRS = new Set(["data", "definitions"]);

Deno.test("finalKeyStates: keeps each key's last op, removals before writes", async () => {
  const commit = modelCommit(1, [
    await savePut("a", 1, "first"),
    await savePut("b", 1),
    deleteVersion("a", 1),
    deleteVersion("c", 1),
    await savePut("a", 1, "again"),
    versionOp("a", 1),
  ]);
  const states = finalKeyStates(commit).map((change) => [
    change.key.toString(),
    change.put === null ? null : change.put.sha256,
  ]);
  assertEquals(states, [
    [dataKey("c", 1).toString(), null],
    [dataKey("a", 1).toString(), (await savePut("a", 1, "again")).sha256],
    [dataKey("b", 1).toString(), (await savePut("b", 1)).sha256],
  ]);
});

Deno.test("decideFile: a put writes a key with no ownership and becomes its owner", () => {
  assertEquals(decideFile(undefined, "p", 5, true), {
    kind: "write",
    next: { owner: "p", mark: 5, present: true },
  });
});

Deno.test("decideFile: a put older in the feed than the file's put leaves it", () => {
  const before = { owner: "q", mark: 9, present: true };
  assertEquals(decideFile(before, "p", 5, true), { kind: "keep" });
  assertEquals(decideFile(before, "p", 9, true), { kind: "keep" });
  assertEquals(decideFile(before, "p", 10, true), {
    kind: "write",
    next: { owner: "p", mark: 10, present: true },
  });
});

Deno.test("decideFile: a tombstone removes only its own partition's present file, keeping the mark", () => {
  const owned = { owner: "p", mark: 4, present: true };
  assertEquals(decideFile(owned, "p", 7, false), {
    kind: "remove",
    next: { owner: "p", mark: 4, present: false },
  });
  assertEquals(decideFile(owned, "q", 7, false), { kind: "keep" });
  assertEquals(
    decideFile({ ...owned, present: false }, "p", 7, false),
    { kind: "keep" },
  );
  // No put of the key was applied: removed, with no ownership to record.
  assertEquals(decideFile(undefined, "p", 7, false), {
    kind: "remove",
    next: undefined,
  });
});

Deno.test("lexicalRefusal: refuses keys outside the synced subdirectories and catalog files", () => {
  assertEquals(lexicalRefusal("data/m/x/1/raw", SUBDIRS), undefined);
  assertEquals(
    lexicalRefusal("secrets/x", SUBDIRS),
    "its first segment secrets is not a datastore-synced directory",
  );
  assertEquals(
    lexicalRefusal("data/_catalog.db-wal", SUBDIRS),
    "it names a catalog database",
  );
});

Deno.test("lexicalConflict: finds a file above the key or a file under it", () => {
  const present = new Set(["data/x", "data/y/z"]);
  const isFile = (key: string) => present.has(key);
  const under = (key: string) =>
    [...present].some((p) => p.startsWith(`${key}/`));
  assertEquals(lexicalConflict("data/x/1", isFile, under), "under-file");
  assertEquals(lexicalConflict("data/y", isFile, under), "directory");
  assertEquals(lexicalConflict("data/x", isFile, under), undefined);
  assertEquals(lexicalConflict("data/w/1", isFile, under), undefined);
});

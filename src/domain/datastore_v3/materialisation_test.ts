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
  type KeyChange,
  lexicalConflict,
  lexicalRefusal,
  type NetReplayPlan,
  NetReplayPlanner,
} from "./materialisation.ts";
import type { PutOp } from "./op.ts";
import { RecordKey } from "./record_key.ts";
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

/** A key change of `key`: a put when `put`, else a tombstone. */
function change(key: string, put: boolean): KeyChange {
  return {
    key: RecordKey.create(key),
    put: put ? ({} as PutOp) : null,
  };
}

function planOf(
  commits: [partition: string, changes: KeyChange[]][],
  options: {
    readonly ignored?: (key: string) => boolean;
    readonly present?: readonly string[];
  } = {},
): NetReplayPlan {
  const planner = new NetReplayPlanner((_, key) =>
    options.ignored?.(key) ?? false
  );
  commits.forEach(([partition, changes], i) =>
    planner.add({ namespace: "", partition, position: i + 1, changes })
  );
  const present = new Set(options.present ?? []);
  return planner.finish((_, segment) => !present.has(segment));
}

Deno.test("NetReplayPlanner: skips a write a later put or the owner's tombstone replaces, never the final one (swamp-club#3803)", () => {
  const plan = planOf([
    ["p", [change("data/x", true)]],
    ["p", [change("data/x", true)]],
    ["p", [change("data/y", true)]],
    ["p", [change("data/y", false)]],
  ]);
  assertEquals(plan.skipsWrite("", "data/x", 1), true);
  assertEquals(plan.skipsWrite("", "data/x", 2), false);
  assertEquals(plan.skipsWrite("", "data/y", 3), true);
  assertEquals(plan.skipsRemoval("", "data/y", 4), true);
  assertEquals(plan.replaceable, 2);
  assertEquals(plan.bound, 4);
});

Deno.test("NetReplayPlanner: keeps a write another partition's tombstone leaves on disk (swamp-club#3803)", () => {
  const plan = planOf([
    ["p", [change("config/k", true)]],
    ["q", [change("config/k", false)]],
  ]);
  assertEquals(plan.skipsWrite("", "config/k", 1), false);
  assertEquals(plan.replaceable, 0);
});

Deno.test("NetReplayPlanner: a key that is another's path prefix, or under one, replays in full (swamp-club#3803)", () => {
  const plan = planOf([
    ["p", [change("data/a", true)]],
    ["p", [change("data/a", true), change("data/a/b", true)]],
    ["p", [change("data/a/b", false), change("data/c", true)]],
    ["p", [change("data/c", true)]],
  ]);
  assertEquals(plan.skipsWrite("", "data/a", 1), false);
  assertEquals(plan.skipsWrite("", "data/a/b", 2), false);
  assertEquals(plan.skipsRemoval("", "data/a/b", 3), false);
  assertEquals(plan.skipsWrite("", "data/c", 3), true);
  assertEquals(plan.replaceable, 3);
  assertEquals(plan.keptForPrefix, 2);
});

Deno.test("NetReplayPlanner: a key whose directory was there before replays in full (swamp-club#3803)", () => {
  const plan = planOf([
    ["p", [change("data/x", true)]],
    ["p", [change("data/x", true)]],
    ["p", [change("outputs/z", false)]],
  ], { present: ["data"] });
  assertEquals(plan.skipsWrite("", "data/x", 1), false);
  assertEquals(plan.keptForDirectory, 1);
  // A key only ever removed, under a directory that was absent.
  assertEquals(plan.skipsRemoval("", "outputs/z", 3), true);
});

Deno.test("NetReplayPlanner: skips nothing past its bound, and nothing of a key it leaves alone (swamp-club#3803)", () => {
  const plan = planOf([
    ["p", [change("data/x", true)]],
    ["p", [change("data/x", true)]],
    ["p", [change("data/local", true)]],
    ["p", [change("data/local", true)]],
  ], { ignored: (key) => key === "data/local" });
  assertEquals(plan.skipsWrite("", "data/x", 1), true);
  assertEquals(plan.skipsWrite("", "data/x", 9), false);
  assertEquals(plan.skipsRemoval("", "data/x", 9), false);
  assertEquals(plan.skipsWrite("", "data/local", 3), false);
  assertEquals(plan.skipsRemoval("", "data/local", 3), false);
});

Deno.test("NetReplayPlanner: keys that differ only by case or composition, or whose prefix does, replay in full (swamp-club#3803)", () => {
  const plan = planOf([
    ["p", [change("config/A.yaml", true), change("config/x.yaml", true)]],
    ["p", [change("config/a.yaml/b", true), change("config/X.yaml", true)]],
    ["p", [
      change("config/A.yaml", true),
      change("config/x.yaml", true),
      change("config/café", true),
    ]],
    ["p", [change("config/café", true), change("config/café", true)]],
  ]);
  assertEquals(plan.skipsWrite("", "config/A.yaml", 1), false);
  assertEquals(plan.skipsWrite("", "config/x.yaml", 1), false);
  assertEquals(plan.skipsWrite("", "config/café", 3), false);
  assertEquals(plan.keptForPrefix, plan.replaceable);
});

/** A plan of a base of `seeds` and the tail after it, at positions 11 on. */
function basePlanOf(
  seeds: [key: string, owner: string, mark: number, present: boolean][],
  tail: [partition: string, changes: KeyChange[]][],
  options: { readonly present?: readonly string[] } = {},
): NetReplayPlan {
  const planner = new NetReplayPlanner(() => false);
  for (const [key, owner, mark, present] of seeds) {
    planner.seed("", key, { owner, mark, present });
  }
  tail.forEach(([partition, changes], i) =>
    planner.add({ namespace: "", partition, position: i + 11, changes })
  );
  const present = new Set(options.present ?? []);
  return planner.finish((_, segment) => !present.has(segment));
}

Deno.test("NetReplayPlanner.seed: a base file the tail replaces or its owner removes is skipped, one it leaves is not (swamp-club#3916)", () => {
  const plan = basePlanOf(
    [
      ["data/replaced", "p", 3, true],
      ["data/removed", "p", 4, true],
      ["data/kept", "p", 5, true],
    ],
    [
      ["p", [change("data/replaced", true)]],
      ["p", [change("data/removed", false)]],
    ],
  );
  assertEquals(plan.skipsWrite("", "data/replaced", 3), true);
  assertEquals(plan.skipsWrite("", "data/replaced", 11), false);
  assertEquals(plan.skipsWrite("", "data/removed", 4), true);
  // Its file was never written, so neither is its removal.
  assertEquals(plan.skipsRemoval("", "data/removed", 12), true);
  assertEquals(plan.skipsWrite("", "data/kept", 5), false);
  assertEquals(plan.replaceable, 2);
});

Deno.test("NetReplayPlanner.seed: starts from the base's ownership, so another partition's tombstone leaves the base file (swamp-club#3916)", () => {
  const plan = basePlanOf(
    [["config/a", "p", 3, true]],
    [["q", [change("config/a", false)]]],
  );
  assertEquals(plan.skipsWrite("", "config/a", 3), false);
  assertEquals(plan.replaceable, 0);
});

Deno.test("NetReplayPlanner.seed: a base file whose directory was there, or that is a tail key's path prefix, is written (swamp-club#3916)", () => {
  const directory = basePlanOf(
    [["data/x", "p", 3, true]],
    [["p", [change("data/x", true)]]],
    { present: ["data"] },
  );
  assertEquals(directory.skipsWrite("", "data/x", 3), false);
  assertEquals(directory.keptForDirectory, 1);
  const prefix = basePlanOf(
    [["data/a", "p", 3, true]],
    [["p", [change("data/a", false), change("data/a/b", true)]]],
  );
  assertEquals(prefix.skipsWrite("", "data/a", 3), false);
  assertEquals(prefix.keptForPrefix, 1);
});

Deno.test("NetReplayPlanner.seed: with no tail nothing is skipped (swamp-club#3916)", () => {
  const plan = basePlanOf([["data/x", "p", 3, true]], []);
  assertEquals(plan.skipsWrite("", "data/x", 3), false);
  assertEquals(plan.bound, 0);
});

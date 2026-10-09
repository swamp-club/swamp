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
import { join } from "@std/path";
import {
  comparePathsBySegment,
  readDirSorted,
  sortDirEntriesByName,
} from "./sorted_dir_entries.ts";

Deno.test("sortDirEntriesByName: sorts by code unit and keeps every entry", () => {
  const entries = [
    { name: "b", isFile: true },
    { name: "a", isFile: false },
    { name: "Z", isFile: true },
    { name: "a1", isFile: true },
  ];
  assertEquals(
    sortDirEntriesByName(entries).map((e) => e.name),
    ["Z", "a", "a1", "b"],
  );
});

Deno.test("sortDirEntriesByName: leaves the input untouched", () => {
  const entries = [{ name: "b" }, { name: "a" }];
  sortDirEntriesByName(entries);
  assertEquals(entries.map((e) => e.name), ["b", "a"]);
});

Deno.test("readDirSorted: returns files and directories in name order", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-sorted-dir-" });
  try {
    await Deno.writeTextFile(join(dir, "mango.yaml"), "");
    await Deno.mkdir(join(dir, "zebra"));
    await Deno.writeTextFile(join(dir, "apple.yaml"), "");
    const entries = await readDirSorted(dir);
    assertEquals(entries.map((e) => e.name), [
      "apple.yaml",
      "mango.yaml",
      "zebra",
    ]);
    assertEquals(entries.map((e) => e.isDirectory), [false, false, true]);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("comparePathsBySegment: a directory sorts before a sibling that extends its name", () => {
  // As whole strings, "a1/x" sorts before "a\x" but after "a/x", so the
  // order would depend on the platform separator.
  const paths = [join("a1", "x"), join("a", "x"), join("a", "b", "y"), "a"];
  assertEquals(paths.sort(comparePathsBySegment), [
    "a",
    join("a", "b", "y"),
    join("a", "x"),
    join("a1", "x"),
  ]);
});

Deno.test("comparePathsBySegment: equal paths compare equal", () => {
  assertEquals(comparePathsBySegment(join("a", "b"), join("a", "b")), 0);
});

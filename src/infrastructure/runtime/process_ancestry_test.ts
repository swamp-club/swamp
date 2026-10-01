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

import { assert, assertEquals } from "@std/assert";
import {
  executablePathOf,
  findAncestor,
  isSameExecutable,
  parentPidOf,
  parseProcStatParentPid,
  stripDeletedSuffix,
} from "./process_ancestry.ts";

const inspectable = Deno.build.os === "linux" || Deno.build.os === "darwin";

Deno.test("parseProcStatParentPid: reads the field after the state", () => {
  assertEquals(parseProcStatParentPid("1234 (swamp) S 99 1234 1234 0"), 99);
});

Deno.test("parseProcStatParentPid: reads past a name with spaces and parentheses", () => {
  assertEquals(parseProcStatParentPid("77 (a) b (c)) R 5 77 77"), 5);
});

Deno.test("parseProcStatParentPid: rejects malformed text", () => {
  assertEquals(parseProcStatParentPid("no name here"), undefined);
  assertEquals(parseProcStatParentPid("1 (x) S notanumber"), undefined);
  assertEquals(parseProcStatParentPid("1 (x)"), undefined);
});

Deno.test("stripDeletedSuffix: strips the marker Linux adds to a replaced binary", () => {
  assertEquals(
    stripDeletedSuffix("/usr/local/bin/swamp (deleted)"),
    "/usr/local/bin/swamp",
  );
  assertEquals(
    stripDeletedSuffix("/usr/local/bin/swamp"),
    "/usr/local/bin/swamp",
  );
});

Deno.test("isSameExecutable: compares resolved paths, and missing paths as written", () => {
  const self = Deno.execPath();
  assert(isSameExecutable(self, Deno.realPathSync(self)));
  assert(isSameExecutable("/no/such/swamp", "/no/such/swamp"));
  assertEquals(isSameExecutable(self, "/no/such/swamp"), false);
});

Deno.test({
  name: "parentPidOf: matches Deno.ppid for this process",
  ignore: !inspectable,
  fn: () => {
    assertEquals(parentPidOf(Deno.pid), Deno.ppid);
  },
});

Deno.test({
  name: "executablePathOf: names this process's own executable",
  ignore: !inspectable,
  fn: () => {
    const path = executablePathOf(Deno.pid);
    assert(path !== undefined);
    assert(isSameExecutable(path, Deno.execPath()));
  },
});

Deno.test({
  name: "findAncestor: the parent is an ancestor, with its executable",
  ignore: !inspectable,
  fn: () => {
    const result = findAncestor(Deno.ppid);
    assertEquals(result.kind, "ancestor");
    if (result.kind === "ancestor") {
      assertEquals(result.executablePath, executablePathOf(Deno.ppid));
    }
  },
});

Deno.test({
  name: "findAncestor: this process is not its own ancestor",
  ignore: !inspectable,
  fn: () => {
    assertEquals(findAncestor(Deno.pid), { kind: "not_ancestor" });
  },
});

Deno.test({
  name: "findAncestor: a pid that is not running is not an ancestor",
  ignore: !inspectable,
  fn: () => {
    // Above the Linux and macOS pid ceilings, so it cannot be running.
    assertEquals(findAncestor(2 ** 30), { kind: "not_ancestor" });
  },
});

Deno.test({
  name: "findAncestor: unsupported platforms answer unknown",
  ignore: inspectable,
  fn: () => {
    assertEquals(findAncestor(Deno.ppid).kind, "unknown");
  },
});

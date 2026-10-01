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

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  executablePathOf,
  findAncestor,
  isSameExecutable,
  parentPidOf,
  parseProcBootTime,
  parseProcStatParentPid,
  parseProcStatStartTicks,
  startTimeOf,
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

Deno.test("parseProcStatStartTicks: reads field 22, past a tricky name", () => {
  // Fields 3..22 after "(name)": state ppid pgrp session tty tpgid flags
  // minflt cminflt majflt cmajflt utime stime cutime cstime priority nice
  // num_threads itrealvalue starttime
  const stat = "9 (a) b (c)) S 1 9 9 0 -1 4194560 10 0 0 0 1 2 0 0 20 0 1 0 " +
    "123456 1000 50";
  assertEquals(parseProcStatStartTicks(stat), 123456);
  assertEquals(parseProcStatStartTicks("9 (x) S 1"), undefined);
});

Deno.test("parseProcBootTime: reads the btime line", () => {
  assertEquals(
    parseProcBootTime("cpu  1 2 3\nintr 5 6\nbtime 1759300000\nprocesses 9\n"),
    1759300000,
  );
  assertEquals(parseProcBootTime("cpu 1 2 3\n"), undefined);
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

// The two negative cases walk the whole chain to pid 1. On a host that hides
// other users' processes (/proc mounted hidepid=2, a sandbox) the walk stops
// early as `unknown`, which the gate treats exactly like `not_ancestor`.

Deno.test({
  name: "findAncestor: this process is not its own ancestor",
  ignore: !inspectable,
  fn: () => {
    assertNotEquals(findAncestor(Deno.pid).kind, "ancestor");
  },
});

Deno.test({
  name: "findAncestor: a pid that is not running is not an ancestor",
  ignore: !inspectable,
  fn: () => {
    // Above the Linux and macOS pid ceilings, so it cannot be running.
    assertNotEquals(findAncestor(2 ** 30).kind, "ancestor");
  },
});

Deno.test({
  name: "findAncestor: unsupported platforms answer unknown",
  ignore: inspectable,
  fn: () => {
    assertEquals(findAncestor(Deno.ppid).kind, "unknown");
  },
});

Deno.test({
  name: "startTimeOf: this process started within the last hour",
  ignore: !inspectable,
  fn: () => {
    const startedAt = startTimeOf(Deno.pid);
    assert(startedAt !== undefined);
    const now = Math.floor(Date.now() / 1000);
    assert(startedAt <= now + 1, `${startedAt} is in the future`);
    assert(startedAt > now - 3600, `${startedAt} is over an hour ago`);
  },
});

Deno.test({
  name: "findAncestor: reports the ancestor's start time, no later than ours",
  ignore: !inspectable,
  fn: () => {
    const result = findAncestor(Deno.ppid);
    assert(result.kind === "ancestor");
    const own = startTimeOf(Deno.pid);
    assert(own !== undefined);
    assertEquals(result.startedAt, startTimeOf(Deno.ppid));
    assert(result.startedAt <= own);
  },
});

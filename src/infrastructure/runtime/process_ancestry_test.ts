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
  commandLineOf,
  executablePathOf,
  findAncestor,
  isSameExecutable,
  parentPidOf,
  parseProcBootTime,
  parseProcCmdline,
  parseProcStatExited,
  parseProcStatParentPid,
  parseProcStatStartTicks,
  processStateOf,
  startTimeOf,
  stripDeletedSuffix,
} from "./process_ancestry.ts";

const inspectable = Deno.build.os === "linux" || Deno.build.os === "darwin";
// The positive cases inspect the test runner's parent, which in a container
// may be a root-owned init this user cannot read.
const parentInspectable = inspectable &&
  executablePathOf(Deno.ppid) !== undefined;

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

Deno.test("parseProcStatExited: reads the state after a tricky name", () => {
  assertEquals(parseProcStatExited("9 (a) b (c)) Z 1 9"), true);
  assertEquals(parseProcStatExited("9 (x) X 1"), true);
  assertEquals(parseProcStatExited("9 (x) S 1"), false);
  assertEquals(parseProcStatExited("9 (x) T 1"), false);
  assertEquals(parseProcStatExited("9 (x)"), undefined);
  assertEquals(parseProcStatExited("no name"), undefined);
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
  ignore: !parentInspectable,
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
  name: "startTimeOf: this process started no later than this module loaded",
  ignore: !inspectable,
  fn: () => {
    const startedAt = startTimeOf(Deno.pid);
    assert(startedAt !== undefined);
    // timeOrigin is when this module's realm started, never before the
    // process did; a second of slack covers whole-second rounding.
    const loadedAt = Math.floor(performance.timeOrigin / 1000);
    assert(startedAt > 0);
    assert(startedAt <= loadedAt + 1, `${startedAt} is after ${loadedAt}`);
  },
});

Deno.test({
  name: "findAncestor: reports the ancestor's start time, no later than ours",
  ignore: !parentInspectable,
  fn: () => {
    const result = findAncestor(Deno.ppid);
    assert(result.kind === "ancestor");
    const own = startTimeOf(Deno.pid);
    assert(own !== undefined);
    assertEquals(result.startedAt, startTimeOf(Deno.ppid));
    assert(result.startedAt <= own);
  },
});

Deno.test("parseProcCmdline: splits on NUL and drops the trailing one", () => {
  assertEquals(parseProcCmdline("swamp\0--x\0a b\0"), ["swamp", "--x", "a b"]);
  assertEquals(parseProcCmdline("one"), ["one"]);
});

Deno.test({
  name: "commandLineOf: reads this process's own arguments on Linux",
  ignore: Deno.build.os !== "linux",
  fn() {
    const args = commandLineOf(Deno.pid);
    assert(args !== undefined && args.length > 0);
  },
});

Deno.test({
  name: "commandLineOf: is undefined off Linux",
  ignore: Deno.build.os === "linux",
  fn() {
    assertEquals(commandLineOf(Deno.pid), undefined);
  },
});

Deno.test({
  name:
    "processStateOf: this process runs, with a start time that does not change",
  ignore: !inspectable,
  fn() {
    const state = processStateOf(Deno.pid);
    assert(state !== undefined);
    assertEquals(state.zombie, false);
    assertEquals(processStateOf(Deno.pid), state);
  },
});

Deno.test({
  name: "processStateOf: a pid no process has reads as unknown",
  ignore: !inspectable,
  fn() {
    assertEquals(processStateOf(2147483646), undefined);
  },
});

Deno.test({
  name: "processStateOf: unsupported platforms answer unknown",
  ignore: inspectable,
  fn() {
    assertEquals(processStateOf(Deno.pid), undefined);
  },
});

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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  isDispatchRunnerInvocation,
  redirectConsoleToStderr,
} from "./dispatch_runner_stdio.ts";

Deno.test("isDispatchRunnerInvocation: matches only worker exec-dispatch", () => {
  assertEquals(isDispatchRunnerInvocation(["worker", "exec-dispatch"]), true);
  assertEquals(isDispatchRunnerInvocation(["worker", "connect"]), false);
  assertEquals(isDispatchRunnerInvocation(["exec-dispatch"]), false);
  assertEquals(isDispatchRunnerInvocation([]), false);
});

/**
 * Runs `fn` with the console redirected into a buffer, then restores it.
 * Replacing the global console is safe here: Deno runs one test file per
 * worker and the tests in a file one at a time, and `finally` restores it.
 */
function withRedirectedConsole(fn: () => void): string[] {
  const methods = ["log", "info", "debug", "dir", "warn", "error"] as const;
  const original = Object.fromEntries(methods.map((m) => [m, console[m]]));
  const lines: string[] = [];
  try {
    redirectConsoleToStderr((line) => lines.push(line));
    fn();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

Deno.test("redirectConsoleToStderr: console.dir goes to the redirect, as the console span exporter writes", () => {
  const lines = withRedirectedConsole(() => {
    console.dir({ traceId: "abc", nested: { depth: { three: 3 } } }, {
      depth: 3,
    });
  });
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], 'traceId: "abc"');
  assertStringIncludes(lines[0], "three: 3");
});

Deno.test("redirectConsoleToStderr: log, info and debug go to the redirect; warn and error are prefixed", () => {
  const lines = withRedirectedConsole(() => {
    console.log("a", 1);
    console.info("b");
    console.debug("c");
    console.warn("d");
    console.error("e");
  });
  assertEquals(lines, ["a 1", "b", "c", "[WARN] d", "[ERROR] e"]);
});

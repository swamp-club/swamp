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
import { hostname } from "node:os";
import {
  checkOpenFileLimit,
  getOpenFileSoftLimit,
  isProcessDead,
  isProcessGone,
  processHostIdentity,
  tryRaiseOpenFileLimit,
} from "./process.ts";

Deno.test("isProcessGone: false for a live process, true for a pid no process can hold", () => {
  assertEquals(isProcessGone(Deno.pid), false);
  assertEquals(isProcessGone(Deno.ppid), false);
  assertEquals(isProcessGone(2147483647), true);
});

Deno.test("isProcessGone: false for a live process of another user", () => {
  if (Deno.build.os === "windows") return;
  assertEquals(isProcessGone(1), false);
});

Deno.test("processHostIdentity: is the hostname, plus the pid namespace on Linux", () => {
  const identity = processHostIdentity();
  if (Deno.build.os === "linux") {
    assertStringIncludes(identity, `${hostname()}#pid:[`);
  } else {
    assertEquals(identity, hostname());
  }
  assertEquals(processHostIdentity(), identity, "stable within a process");
});

Deno.test("isProcessDead: returns false for the current process", () => {
  assertEquals(isProcessDead(Deno.pid), false);
});

Deno.test("isProcessDead: returns true for a non-existent PID", () => {
  // PID 2147483647 is the max 32-bit signed int — extremely unlikely to be in use
  assertEquals(isProcessDead(2147483647), true);
});

Deno.test("getOpenFileSoftLimit: returns a positive number or null on POSIX", () => {
  if (Deno.build.os === "windows") return;
  const limit = getOpenFileSoftLimit();
  if (limit === null) return;
  assertEquals(typeof limit, "number");
  assertEquals(limit > 0, true);
});

Deno.test("checkOpenFileLimit: returns null when limit is sufficient", () => {
  if (Deno.build.os === "windows") return;
  const limit = getOpenFileSoftLimit();
  if (limit === null || limit < 8192) return;
  assertEquals(checkOpenFileLimit(), null);
});

Deno.test("tryRaiseOpenFileLimit: returns without throwing", () => {
  const result = tryRaiseOpenFileLimit();
  assertEquals(typeof result.raised, "boolean");
  if (!result.raised) {
    assertEquals(typeof result.reason, "string");
  }
});

Deno.test("tryRaiseOpenFileLimit: is idempotent", () => {
  const first = tryRaiseOpenFileLimit();
  const second = tryRaiseOpenFileLimit();
  if (first.raised) {
    assertEquals(second.raised, false);
    assertEquals(
      (second as { raised: false; reason: string }).reason,
      "already sufficient",
    );
  }
});

Deno.test("tryRaiseOpenFileLimit: returns raised=false on Windows", () => {
  if (Deno.build.os !== "windows") return;
  const result = tryRaiseOpenFileLimit();
  assertEquals(result.raised, false);
  assertEquals(
    (result as { raised: false; reason: string }).reason,
    "windows",
  );
});

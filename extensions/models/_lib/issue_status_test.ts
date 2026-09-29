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

import { assertEquals, assertThrows } from "@std/assert";
import {
  parsePrNumber,
  statusPath,
  upstreamStatusForPhase,
} from "./issue_status.ts";
import { Phase } from "./schemas.ts";

Deno.test("statusPath: walks open to shipped one step at a time", () => {
  assertEquals(statusPath("open", "shipped"), [
    "triaged",
    "in_progress",
    "shipped",
  ]);
});

Deno.test("statusPath: is empty when the issue is already at the target", () => {
  assertEquals(statusPath("in_progress", "in_progress"), []);
});

Deno.test("statusPath: never moves an issue backwards", () => {
  assertEquals(statusPath("shipped", "triaged"), []);
});

Deno.test("statusPath: reopens a closed issue before walking it", () => {
  assertEquals(statusPath("closed", "in_progress"), [
    "open",
    "triaged",
    "in_progress",
  ]);
  assertEquals(statusPath("closed", "open"), ["open"]);
});

Deno.test("statusPath: refuses a status it does not know", () => {
  assertThrows(() => statusPath("archived", "shipped"), Error, "archived");
});

Deno.test("upstreamStatusForPhase: maps every phase to the primary's status", () => {
  const expected: Record<Phase, string> = {
    created: "open",
    triaging: "open",
    classified: "triaged",
    plan_generated: "triaged",
    approved: "in_progress",
    implementing: "in_progress",
    verifying: "in_progress",
    pr_open: "in_progress",
    pr_failed: "in_progress",
    releasing: "in_progress",
    notify: "shipped",
    summarizing: "shipped",
    done: "shipped",
  };
  for (const phase of Phase.options) {
    assertEquals(upstreamStatusForPhase(phase), expected[phase], phase);
  }
});

Deno.test("parsePrNumber: reads the number from a pull request URL", () => {
  assertEquals(
    parsePrNumber("https://github.com/swamp-club/swamp/pull/2701"),
    2701,
  );
  assertEquals(
    parsePrNumber("https://github.com/swamp-club/swamp/pull/12/files"),
    12,
  );
  assertEquals(parsePrNumber("https://github.com/o/r/pull/7?x=1"), 7);
});

Deno.test("parsePrNumber: is undefined when the URL names no pull request", () => {
  assertEquals(
    parsePrNumber("https://gitlab.com/o/r/-/merge_requests/3"),
    undefined,
  );
  assertEquals(parsePrNumber("https://github.com/o/r/pull/12abc"), undefined);
});

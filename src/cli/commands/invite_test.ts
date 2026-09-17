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

import { assertEquals, assertNotEquals } from "@std/assert";
import { inviteCommand } from "./invite.ts";

Deno.test("inviteCommand: has correct name and description", () => {
  assertEquals(inviteCommand.getName(), "invite");
  assertEquals(
    inviteCommand.getDescription(),
    "Invite people to swamp-club",
  );
});

Deno.test("inviteCommand: exposes link, and nothing else", () => {
  const link = inviteCommand.getCommand("link");
  assertNotEquals(link, undefined);
  assertEquals(link?.getName(), "link");

  // The `first-rule` egg moved to the top level (`swamp first-rule`), so it is
  // not reachable here even when typed in full — hidden commands included.
  assertEquals(inviteCommand.getCommand("first-rule", true), undefined);

  const listed = inviteCommand.getCommands(false).map((c) => c.getName());
  assertEquals(listed, ["link"]);
});

Deno.test("inviteCommand: takes no positional arguments", () => {
  // A pure group, like `swamp issue`. The earlier `[email]` positional was
  // withdrawn rather than left advertising an unbuilt feature; this pins that
  // decision so it is not reintroduced by accident.
  assertEquals(inviteCommand.getArguments().length, 0);
});

Deno.test("inviteCommand: bare invocation prints help instead of throwing", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await inviteCommand.parse([]);
  } finally {
    console.log = originalLog;
  }

  assertEquals(logs.join("\n").includes("link"), true);
});

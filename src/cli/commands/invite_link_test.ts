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
import { Command } from "@cliffy/command";
import { firstRuleCommand, inviteLinkCommand } from "./invite_link.ts";

Deno.test("inviteLinkCommand: has correct name and description", () => {
  assertEquals(inviteLinkCommand.getName(), "link");
  assertEquals(
    inviteLinkCommand.getDescription(),
    "Print your swamp-club invite link",
  );
});

Deno.test("firstRuleCommand: same command, hidden from help", () => {
  assertEquals(firstRuleCommand.getName(), "first-rule");
  // It carries the same description as `link`, so the two cannot drift.
  assertEquals(
    firstRuleCommand.getDescription(),
    inviteLinkCommand.getDescription(),
  );
  // And `link` itself no longer carries it as an alias.
  assertEquals(inviteLinkCommand.getAliases(), []);

  // Cliffy exposes no public isHidden() reader, so the flag is read the way
  // help does: register under a throwaway parent and filter. Mounting it here
  // rather than on the real tree keeps this a unit test — `swamp first-rule`
  // is wired in src/cli/mod.ts, which only builds inside runCli().
  const parent = new Command().command("first-rule", firstRuleCommand);
  assertEquals(parent.getCommands(false).length, 0);
  assertEquals(parent.getCommand("first-rule", true)?.getName(), "first-rule");
});

Deno.test("firstRuleCommand: examples spell the egg's own invocation", () => {
  // The egg is reached as `swamp first-rule`, so its `--help` must not point
  // at `swamp invite link` — that would give away a command the user did not
  // ask about and describe a path they did not take.
  const example = firstRuleCommand.getExample("Print your invite link");
  assertEquals(example?.description, "swamp first-rule");
  assertEquals(
    inviteLinkCommand.getExample("Print your invite link")?.description,
    "swamp invite link",
  );
});

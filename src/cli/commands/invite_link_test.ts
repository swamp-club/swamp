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
import { inviteFirstRuleCommand, inviteLinkCommand } from "./invite_link.ts";

Deno.test("inviteLinkCommand: has correct name and description", () => {
  assertEquals(inviteLinkCommand.getName(), "link");
  assertEquals(
    inviteLinkCommand.getDescription(),
    "Print your swamp-club recruit link, creating it on first use",
  );
});

Deno.test("inviteFirstRuleCommand: same command, hidden from help", () => {
  assertEquals(inviteFirstRuleCommand.getName(), "first-rule");
  // Hiddenness is asserted in invite_test.ts, where the group can be filtered
  // with getCommands(false) — Cliffy exposes no public isHidden() reader.
  // It carries the same description as `link`, so the two cannot drift.
  assertEquals(
    inviteFirstRuleCommand.getDescription(),
    inviteLinkCommand.getDescription(),
  );
  // And `link` itself no longer carries it as an alias.
  assertEquals(inviteLinkCommand.getAliases(), []);
});

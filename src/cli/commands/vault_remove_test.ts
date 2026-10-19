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
import { vaultRemoveCommand } from "./vault_remove.ts";
import { vaultCommand } from "./vault.ts";

Deno.test("vaultRemoveCommand: is registered as swamp vault remove", () => {
  assertEquals(vaultCommand.getCommand("remove"), vaultRemoveCommand);
});

Deno.test("vaultRemoveCommand: takes one vault name and no key", () => {
  const args = vaultRemoveCommand.getArguments();
  assertEquals(args.map((a) => a.name), ["vault_name"]);
  assertEquals(args[0].optional, false);
});

Deno.test("vaultRemoveCommand: offers --yes and --force", () => {
  assertEquals(vaultRemoveCommand.getOption("yes")?.aliases, ["y"]);
  assertEquals(vaultRemoveCommand.getOption("force")?.aliases, ["f"]);
});

Deno.test("vaultRemoveCommand: help says the removal cannot be undone and points to vault delete", () => {
  const description = vaultRemoveCommand.getDescription();
  assertStringIncludes(description, "cannot be undone");
  assertStringIncludes(description, "swamp vault delete <vault> <key>");
});

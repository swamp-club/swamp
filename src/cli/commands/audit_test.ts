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

import { assertEquals, assertExists } from "@std/assert";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

import "../../domain/models/models.ts";
import { auditCommand } from "./audit.ts";

await initializeLogging({});

// Registers auditCommand once, as a single registerCommands pass does. This
// file must not import ../mod.ts: Cliffy's hidden flag cannot be unset, so a
// second registration there could hide audit and mask a regression here.
const root = new Command().name("swamp").command("audit", auditCommand);

Deno.test("auditCommand: is hidden after a single registration", () => {
  assertEquals(root.getCommand("audit", false), undefined);
  assertExists(root.getCommand("audit", true));
});

Deno.test("auditCommand: hides none of its subcommands", () => {
  assertEquals(
    auditCommand.getCommands(false).map((cmd) => cmd.getName()),
    ["record", "alerts", "export", "log", "report", "rotate-key", "verify"],
  );
});

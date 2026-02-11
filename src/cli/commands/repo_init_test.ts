// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("repoCommand module loads", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  assertEquals(repoCommand.getName(), "repo");
});

Deno.test("repoInitCommand is registered as subcommand", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  const commands = repoCommand.getCommands();
  const initCmd = commands.find((c) => c.getName() === "init");
  assertEquals(initCmd !== undefined, true);
});

Deno.test("repoUpgradeCommand is registered as subcommand", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  const commands = repoCommand.getCommands();
  const upgradeCmd = commands.find((c) => c.getName() === "upgrade");
  assertEquals(upgradeCmd !== undefined, true);
});

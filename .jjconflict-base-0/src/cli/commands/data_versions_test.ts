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

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("dataVersionsCommand module loads", async () => {
  const { dataVersionsCommand } = await import("./data_versions.ts");
  assertEquals(dataVersionsCommand.getName(), "versions");
});

Deno.test("dataVersionsCommand has correct description", async () => {
  const { dataVersionsCommand } = await import("./data_versions.ts");
  assertEquals(
    dataVersionsCommand.getDescription(),
    "List all versions of specific data",
  );
});

Deno.test("dataVersionsCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const versionsCmd = commands.find((c) => c.getName() === "versions");
  assertEquals(versionsCmd !== undefined, true);
});

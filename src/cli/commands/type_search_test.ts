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
import type { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("typeSearchCommand module loads", async () => {
  const { typeSearchCommand } = await import("./type_search.ts");
  assertEquals(typeSearchCommand.getName(), "search");
});

Deno.test("typeSearchCommand has correct description", async () => {
  const { typeSearchCommand } = await import("./type_search.ts");
  assertEquals(
    typeSearchCommand.getDescription(),
    "Search for model types",
  );
});

Deno.test("typeSearchCommand is registered as subcommand of modelTypeCommand", async () => {
  const { modelTypeCommand } = await import("./model_type.ts");
  const commands = modelTypeCommand.getCommands();
  const searchCmd = commands.find((c: Command) => c.getName() === "search");
  assertEquals(searchCmd !== undefined, true);
});

Deno.test("typeSearchCommand accepts --repo-dir for agentic-flow consistency", async () => {
  // type search reads only the global extension catalog and does not
  // require an initialized repo, but the option is accepted so agents
  // can pass it uniformly across all swamp commands. (swamp-club#235)
  const { typeSearchCommand } = await import("./type_search.ts");
  const names = typeSearchCommand.getOptions().map((o) => o.name);
  if (!names.includes("repo-dir")) {
    throw new Error(
      `expected --repo-dir option, got: ${names.join(", ")}`,
    );
  }
});

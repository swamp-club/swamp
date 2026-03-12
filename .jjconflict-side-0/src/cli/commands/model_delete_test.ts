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

Deno.test("modelDeleteCommand module loads", async () => {
  const { modelDeleteCommand } = await import("./model_delete.ts");
  assertEquals(modelDeleteCommand.getName(), "delete");
});

Deno.test("modelDeleteCommand has correct description", async () => {
  const { modelDeleteCommand } = await import("./model_delete.ts");
  assertEquals(
    modelDeleteCommand.getDescription(),
    "Delete a model and all related artifacts",
  );
});

Deno.test("modelDeleteCommand is registered as subcommand of modelCommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const deleteCmd = commands.find((c) => c.getName() === "delete");
  assertEquals(deleteCmd !== undefined, true);
});

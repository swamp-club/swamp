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

// Note: Full CLI integration tests are in integration/echo_model_test.ts
// These tests verify the command module loads correctly

Deno.test("modelCommand module loads", async () => {
  const { modelCommand } = await import("./model_create.ts");
  assertEquals(modelCommand.getName(), "model");
});

Deno.test("modelCreateCommand is registered as subcommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create");
  assertEquals(createCmd !== undefined, true);
});

Deno.test("modelValidateCommand is registered as subcommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const validateCmd = commands.find((c) => c.getName() === "validate");
  assertEquals(validateCmd !== undefined, true);
});

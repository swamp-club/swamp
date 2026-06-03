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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("modelMethodDescribeCommand module loads", async () => {
  const { modelMethodDescribeCommand } = await import(
    "./model_method_describe.ts"
  );
  assertEquals(modelMethodDescribeCommand.getName(), "describe");
});

Deno.test("modelMethodDescribeCommand has correct description", async () => {
  const { modelMethodDescribeCommand } = await import(
    "./model_method_describe.ts"
  );
  assertEquals(
    modelMethodDescribeCommand.getDescription(),
    "Describe a method on a model with argument details",
  );
});

Deno.test("modelMethodCommand has describe as subcommand", async () => {
  const { modelMethodCommand } = await import("./model_method_run.ts");
  const commands = modelMethodCommand.getCommands();
  const describeCmd = commands.find((cmd) => cmd.getName() === "describe");
  assertEquals(describeCmd !== undefined, true);
});

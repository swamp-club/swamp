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

Deno.test("workflowSchemaCommand module loads", async () => {
  const { workflowSchemaCommand } = await import("./workflow_schema.ts");
  assertEquals(workflowSchemaCommand.getName(), "schema");
});

Deno.test("workflowSchemaGetCommand is registered as subcommand", async () => {
  const { workflowSchemaCommand } = await import("./workflow_schema.ts");
  const commands = workflowSchemaCommand.getCommands();
  const getCmd = commands.find((c) => c.getName() === "get");
  assertEquals(getCmd !== undefined, true);
});

Deno.test("workflowSchemaGetCommand has correct description", async () => {
  const { workflowSchemaGetCommand } = await import("./workflow_schema.ts");
  assertEquals(
    workflowSchemaGetCommand.getDescription(),
    "Get the schema for workflow files",
  );
});

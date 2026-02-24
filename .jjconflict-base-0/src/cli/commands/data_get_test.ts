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

Deno.test("dataGetCommand module loads", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  assertEquals(dataGetCommand.getName(), "get");
});

Deno.test("dataGetCommand has correct description", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  assertEquals(
    dataGetCommand.getDescription(),
    "Get data by model and name, or by workflow",
  );
});

Deno.test("dataGetCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const getCmd = commands.find((c) => c.getName() === "get");
  assertEquals(getCmd !== undefined, true);
});

Deno.test("dataGetCommand has --workflow option", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const workflowOpt = options.find((o) => o.name === "workflow");
  assertEquals(workflowOpt !== undefined, true);
});

Deno.test("dataGetCommand has --run option", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const runOpt = options.find((o) => o.name === "run");
  assertEquals(runOpt !== undefined, true);
});

Deno.test("dataGetCommand accepts optional model argument", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const args = dataGetCommand.getArguments();
  assertEquals(args.length > 0, true);
});

Deno.test("dataGetCommand has --no-content option", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const contentOpt = options.find((o) => o.name === "no-content");
  assertEquals(contentOpt !== undefined, true);
});

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

Deno.test("workflowDeleteCommand module loads", async () => {
  const { workflowDeleteCommand } = await import("./workflow_delete.ts");
  assertEquals(workflowDeleteCommand.getName(), "delete");
});

Deno.test("workflowDeleteCommand has correct description", async () => {
  const { workflowDeleteCommand } = await import("./workflow_delete.ts");
  assertEquals(
    workflowDeleteCommand.getDescription(),
    "Delete a workflow and its run history",
  );
});

Deno.test("workflowDeleteCommand is registered as subcommand of workflowCommand", async () => {
  const { workflowCommand } = await import("./workflow.ts");
  const commands = workflowCommand.getCommands();
  const deleteCmd = commands.find((c) => c.getName() === "delete");
  assertEquals(deleteCmd !== undefined, true);
});

Deno.test("workflowDeleteCommand has --force option", async () => {
  const { workflowDeleteCommand } = await import("./workflow_delete.ts");
  const options = workflowDeleteCommand.getOptions();
  const forceOption = options.find((o) =>
    o.flags.includes("-f") || o.flags.includes("--force")
  );
  assertEquals(forceOption !== undefined, true);
});

Deno.test("workflowDeleteCommand has --repo-dir option", async () => {
  const { workflowDeleteCommand } = await import("./workflow_delete.ts");
  const options = workflowDeleteCommand.getOptions();
  const repoDirOption = options.find((o) => o.flags.includes("--repo-dir"));
  assertEquals(repoDirOption !== undefined, true);
});

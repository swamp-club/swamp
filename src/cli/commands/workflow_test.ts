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
import { createWorkflowCommand } from "./workflow.ts";
import { WORKFLOW_ROUTES } from "./workflow_routes.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

async function childNames(rest: string[]): Promise<string[]> {
  return (await createWorkflowCommand(rest)).getCommands(true).map((c) =>
    c.getName()
  );
}

Deno.test("createWorkflowCommand: no rest registers every subcommand in table order", async () => {
  assertEquals(
    await childNames([]),
    WORKFLOW_ROUTES.map((route) => route.name),
  );
});

Deno.test("createWorkflowCommand: a subcommand word or alias registers only that subcommand", async () => {
  assertEquals(await childNames(["run", "wf"]), ["run"]);
  assertEquals(await childNames(["list"]), ["search"]);
  assertEquals(await childNames(["history", "search"]), ["history"]);
});

Deno.test("createWorkflowCommand: an unknown word registers every subcommand", async () => {
  assertEquals(
    (await childNames(["rnu"])).length,
    WORKFLOW_ROUTES.length,
  );
});

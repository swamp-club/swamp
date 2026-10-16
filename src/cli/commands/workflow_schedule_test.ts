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

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("workflowScheduleCommand: has pause, resume and list subcommands", async () => {
  const { workflowScheduleCommand } = await import("./workflow_schedule.ts");
  assertEquals(workflowScheduleCommand.getName(), "schedule");
  assertEquals(
    workflowScheduleCommand.getCommands().map((c) => c.getName()).sort(),
    ["list", "pause", "resume"],
  );
});

Deno.test("workflowCommand: has schedule subcommand", async () => {
  const { workflowCommand } = await import("./workflow.ts");
  assertEquals(
    workflowCommand.getCommands().some((c) => c.getName() === "schedule"),
    true,
  );
});

Deno.test("workflowSchedulePauseCommand: takes a workflow and --reason, --until, --repo-dir and --server", async () => {
  const { workflowSchedulePauseCommand } = await import(
    "./workflow_schedule_pause.ts"
  );
  assertEquals(workflowSchedulePauseCommand.getName(), "pause");
  const names = workflowSchedulePauseCommand.getOptions().map((o) => o.name);
  for (const name of ["reason", "until", "repo-dir", "server"]) {
    assertEquals(names.includes(name), true, name);
  }
  assertEquals(workflowSchedulePauseCommand.getArguments().length, 1);
});

Deno.test("workflowScheduleResumeCommand: takes a workflow and --repo-dir and --server", async () => {
  const { workflowScheduleResumeCommand } = await import(
    "./workflow_schedule_resume.ts"
  );
  assertEquals(workflowScheduleResumeCommand.getName(), "resume");
  const names = workflowScheduleResumeCommand.getOptions().map((o) => o.name);
  for (const name of ["repo-dir", "server"]) {
    assertEquals(names.includes(name), true, name);
  }
  assertEquals(workflowScheduleResumeCommand.getArguments().length, 1);
});

Deno.test("workflowScheduleListCommand: takes no arguments and --repo-dir and --server", async () => {
  const { workflowScheduleListCommand } = await import(
    "./workflow_schedule_list.ts"
  );
  assertEquals(workflowScheduleListCommand.getName(), "list");
  const names = workflowScheduleListCommand.getOptions().map((o) => o.name);
  for (const name of ["repo-dir", "server"]) {
    assertEquals(names.includes(name), true, name);
  }
  assertEquals(workflowScheduleListCommand.getArguments().length, 0);
});

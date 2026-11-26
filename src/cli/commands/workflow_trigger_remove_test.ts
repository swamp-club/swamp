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

Deno.test("workflowTriggerRemoveCommand: has correct name", async () => {
  const { workflowTriggerRemoveCommand } = await import(
    "./workflow_trigger_remove.ts"
  );
  assertEquals(workflowTriggerRemoveCommand.getName(), "remove");
});

Deno.test("workflowTriggerRemoveCommand: has repo-dir option", async () => {
  const { workflowTriggerRemoveCommand } = await import(
    "./workflow_trigger_remove.ts"
  );
  const options = workflowTriggerRemoveCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

Deno.test("workflowTriggerCommand: has all subcommands", async () => {
  const { workflowTriggerCommand } = await import("./workflow_trigger.ts");
  const commands = workflowTriggerCommand.getCommands();
  const names = commands.map((c) => c.getName());
  assertEquals(names.includes("set"), true);
  assertEquals(names.includes("get"), true);
  assertEquals(names.includes("remove"), true);
});

Deno.test("workflowCommand: has trigger subcommand", async () => {
  const { createWorkflowCommand } = await import("./workflow.ts");
  const workflowCommand = await createWorkflowCommand();
  const commands = workflowCommand.getCommands();
  const trigger = commands.find((c) => c.getName() === "trigger");
  assertEquals(trigger !== undefined, true);
});

Deno.test("workflowTriggerRemoveCommand: keeps serve.yaml's version and federation", async () => {
  const { Command } = await import("@cliffy/command");
  const { withMockedEnv } = await import(
    "../../infrastructure/persistence/path_test_helpers.ts"
  );
  const { readServeConfigFile, writeServeConfigFile } = await import(
    "../../serve/serve_config.ts"
  );
  const { workflowTriggerRemoveCommand } = await import(
    "./workflow_trigger_remove.ts"
  );
  const dir = await Deno.makeTempDir({ prefix: "swamp-trigger-remove-" });
  try {
    await writeServeConfigFile(dir, {
      version: 2,
      federation: { role: "hub" },
      triggers: { "scan-cves": { schedule: "0 3 * * *" } },
    });
    await withMockedEnv(
      { SWAMP_SERVE_URL: undefined, SWAMP_SERVER_URL: undefined },
      () =>
        new Command()
          .throwErrors()
          .globalOption("--json", "JSON output")
          .command("remove", workflowTriggerRemoveCommand)
          .parse(["remove", "scan-cves", "--json", "--repo-dir", dir]),
    );
    const config = await readServeConfigFile(dir);
    assertEquals(config?.version, 2);
    assertEquals(config?.federation, { role: "hub" });
    assertEquals(config?.triggers, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

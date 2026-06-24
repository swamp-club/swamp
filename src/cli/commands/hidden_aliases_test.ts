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

Deno.test("model list is registered as a hidden subcommand", async () => {
  const { modelCommand } = await import("./model_create.ts");

  // getCommand with second arg true includes hidden commands
  const listCmd = modelCommand.getCommand("list", true);
  assertEquals(
    listCmd !== undefined,
    true,
    "list command should be registered",
  );

  // Verify it's hidden: not in getCommands() (which excludes hidden)
  const visibleCommands = modelCommand.getCommands();
  const visibleList = visibleCommands.find((c) => c.getName() === "list");
  assertEquals(
    visibleList,
    undefined,
    "list should not appear in visible commands",
  );
});

Deno.test("workflow history list is registered as a hidden subcommand", async () => {
  const { workflowHistoryCommand } = await import("./workflow_history.ts");

  // getCommand with second arg true includes hidden commands
  const listCmd = workflowHistoryCommand.getCommand("list", true);
  assertEquals(
    listCmd !== undefined,
    true,
    "list command should be registered",
  );

  // Verify it's hidden: not in getCommands() (which excludes hidden)
  const visibleCommands = workflowHistoryCommand.getCommands();
  const visibleList = visibleCommands.find((c) => c.getName() === "list");
  assertEquals(
    visibleList,
    undefined,
    "list should not appear in visible commands",
  );
});

Deno.test("vault list is registered as a hidden subcommand", async () => {
  const { vaultCommand } = await import("./vault.ts");

  // getCommand with second arg true includes hidden commands
  const listCmd = vaultCommand.getCommand("list", true);
  assertEquals(
    listCmd !== undefined,
    true,
    "list command should be registered",
  );

  // Verify it's hidden: not in getCommands() (which excludes hidden)
  const visibleCommands = vaultCommand.getCommands();
  const visibleList = visibleCommands.find((c) => c.getName() === "list");
  assertEquals(
    visibleList,
    undefined,
    "list should not appear in visible commands",
  );
});

Deno.test("vault type list is registered as a hidden subcommand", async () => {
  const { vaultTypeCommand } = await import("./vault.ts");

  // getCommand with second arg true includes hidden commands
  const listCmd = vaultTypeCommand.getCommand("list", true);
  assertEquals(
    listCmd !== undefined,
    true,
    "list command should be registered",
  );

  // Verify it's hidden: not in getCommands() (which excludes hidden)
  const visibleCommands = vaultTypeCommand.getCommands();
  const visibleList = visibleCommands.find((c) => c.getName() === "list");
  assertEquals(
    visibleList,
    undefined,
    "list should not appear in visible commands",
  );
});

Deno.test("model method run has hidden --arg option", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  const allOptions = modelMethodRunCommand.getOptions(true);
  const argOpt = allOptions.find((o) => o.name === "arg");
  assertEquals(argOpt !== undefined, true, "--arg should be registered");
  assertEquals(argOpt!.hidden, true, "--arg should be hidden");

  const visibleOptions = modelMethodRunCommand.getOptions();
  const visibleArg = visibleOptions.find((o) => o.name === "arg");
  assertEquals(
    visibleArg,
    undefined,
    "--arg should not appear in visible options",
  );
});

Deno.test("workflow run has hidden --arg option", async () => {
  const { workflowRunCommand } = await import("./workflow_run.ts");
  const allOptions = workflowRunCommand.getOptions(true);
  const argOpt = allOptions.find((o) => o.name === "arg");
  assertEquals(argOpt !== undefined, true, "--arg should be registered");
  assertEquals(argOpt!.hidden, true, "--arg should be hidden");

  const visibleOptions = workflowRunCommand.getOptions();
  const visibleArg = visibleOptions.find((o) => o.name === "arg");
  assertEquals(
    visibleArg,
    undefined,
    "--arg should not appear in visible options",
  );
});

Deno.test("workflow evaluate has hidden --arg option", async () => {
  const { workflowEvaluateCommand } = await import("./workflow_evaluate.ts");
  const allOptions = workflowEvaluateCommand.getOptions(true);
  const argOpt = allOptions.find((o) => o.name === "arg");
  assertEquals(argOpt !== undefined, true, "--arg should be registered");
  assertEquals(argOpt!.hidden, true, "--arg should be hidden");

  const visibleOptions = workflowEvaluateCommand.getOptions();
  const visibleArg = visibleOptions.find((o) => o.name === "arg");
  assertEquals(
    visibleArg,
    undefined,
    "--arg should not appear in visible options",
  );
});

Deno.test("workflow resume has hidden --arg option", async () => {
  const { workflowResumeCommand } = await import("./workflow_resume.ts");
  const allOptions = workflowResumeCommand.getOptions(true);
  const argOpt = allOptions.find((o) => o.name === "arg");
  assertEquals(argOpt !== undefined, true, "--arg should be registered");
  assertEquals(argOpt!.hidden, true, "--arg should be hidden");

  const visibleOptions = workflowResumeCommand.getOptions();
  const visibleArg = visibleOptions.find((o) => o.name === "arg");
  assertEquals(
    visibleArg,
    undefined,
    "--arg should not appear in visible options",
  );
});

Deno.test("repo init is registered as a visible subcommand", async () => {
  const { repoCommand } = await import("./repo_init.ts");

  const visibleCommands = repoCommand.getCommands();
  const visibleInit = visibleCommands.find((c) => c.getName() === "init");
  assertEquals(
    visibleInit !== undefined,
    true,
    "init should appear in visible commands",
  );
});

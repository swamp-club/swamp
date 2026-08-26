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

import { assertEquals, assertStrictEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("model search has list as a native alias", async () => {
  const { modelSearchCommand } = await import("./model_search.ts");
  assertEquals(
    modelSearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
  );
});

Deno.test("model list resolves to the search command", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const searchCmd = modelCommand.getCommand("search");
  const listCmd = modelCommand.getCommand("list", true);
  assertStrictEquals(listCmd, searchCmd, "list should resolve to search");
});

Deno.test("workflow search has list as a native alias", async () => {
  const { workflowSearchCommand } = await import("./workflow_search.ts");
  assertEquals(
    workflowSearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
  );
});

Deno.test("workflow run search has list as a native alias", async () => {
  const { workflowRunSearchCommand } = await import(
    "./workflow_run_search.ts"
  );
  assertEquals(
    workflowRunSearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
  );
});

Deno.test("workflow history search has list as a native alias", async () => {
  const { workflowHistorySearchCommand } = await import(
    "./workflow_history_search.ts"
  );
  assertEquals(
    workflowHistorySearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
  );
});

Deno.test("model output search has list as a native alias", async () => {
  const { modelOutputSearchCommand } = await import(
    "./model_output_search.ts"
  );
  assertEquals(
    modelOutputSearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
  );
});

Deno.test("model type search has list as a native alias", async () => {
  const { typeSearchCommand } = await import("./type_search.ts");
  assertEquals(
    typeSearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
  );
});

Deno.test("model method history search has list as a native alias", async () => {
  const { modelMethodHistorySearchCommand } = await import(
    "./model_method_history_search.ts"
  );
  assertEquals(
    modelMethodHistorySearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
  );
});

Deno.test("vault search has list as a native alias", async () => {
  const { vaultSearchCommand } = await import("./vault_search.ts");
  assertEquals(
    vaultSearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
  );
});

Deno.test("vault type search has list as a native alias", async () => {
  const { vaultTypeSearchCommand } = await import("./vault_type_search.ts");
  assertEquals(
    vaultTypeSearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
  );
});

Deno.test("report type search has list as a native alias", async () => {
  const { reportTypeSearchCommand } = await import(
    "./report_type_search.ts"
  );
  assertEquals(
    reportTypeSearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
  );
});

Deno.test("datastore type search has list as a native alias", async () => {
  const { datastoreTypeSearchCommand } = await import(
    "./datastore_type_search.ts"
  );
  assertEquals(
    datastoreTypeSearchCommand.getAliases().includes("list"),
    true,
    "search command should have 'list' alias",
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

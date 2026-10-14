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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { Command, FileType } from "@cliffy/command";
import { generatePowerShellCompletions } from "./completion_powershell.ts";
import { completionCommand } from "./completion.ts";

function sampleTree() {
  const plan = new Command()
    .description("Plan the deploy")
    .arguments("<step:string>");
  const deploy = new Command()
    .description("Deploy it's thing")
    .alias("dep")
    .option("--target <env:string>", "Target environment")
    .option("--from <name:thing_name>", "Source thing")
    .option("--config <path:file>", "Config file")
    .option("--tag [tag:string]", "Optional tag")
    .option("--internal", "Hidden option", { hidden: true })
    .arguments("<name:thing_name> [paths...:file]")
    .command("plan", plan);
  const secret = new Command().description("Hidden command").hidden();
  return new Command()
    .name("tool")
    .globalType("file", new FileType())
    .globalOption("--verbose", "Show more")
    .globalComplete("thing_name", () => ["alpha", "beta"])
    .command("deploy", deploy)
    .command("secret", secret);
}

/** The script line holding the tree entry for `path`. */
function nodeBlock(script: string, path: string): string {
  const start = script.indexOf(`    '${path}' = @{`);
  if (start === -1) throw new Error(`no tree entry for '${path}'`);
  const end = script.indexOf("\n    }", start);
  return script.slice(start, end);
}

Deno.test("generatePowerShellCompletions: registers a native completer for the name and name.exe", () => {
  const script = generatePowerShellCompletions("tool", sampleTree());
  assertStringIncludes(script, "$commandName = 'tool'");
  assertStringIncludes(
    script,
    "Register-ArgumentCompleter -Native -CommandName @($commandName, ($commandName + '.exe'))",
  );
  assertStringIncludes(
    script,
    "tool completions powershell | Out-String | Invoke-Expression",
  );
});

Deno.test("generatePowerShellCompletions: honours a custom name", () => {
  const script = generatePowerShellCompletions("other", sampleTree());
  assertStringIncludes(script, "$commandName = 'other'");
});

Deno.test("generatePowerShellCompletions: throws without a main command name", () => {
  assertThrows(() => generatePowerShellCompletions("", sampleTree()));
  assertThrows(() => generatePowerShellCompletions("COMMAND", sampleTree()));
});

Deno.test("generatePowerShellCompletions: lists subcommands with aliases and leaves hidden ones out", () => {
  const script = generatePowerShellCompletions("tool", sampleTree());
  const root = nodeBlock(script, "");
  assertStringIncludes(
    root,
    "@{ Name = 'deploy'; Aliases = @('dep'); Description = 'Deploy it''s thing' }",
  );
  assertEquals(root.includes("secret"), false);
  assertEquals(script.includes("'secret' = @{"), false);
  assertStringIncludes(
    nodeBlock(script, "deploy"),
    "@{ Name = 'plan'; Aliases = @(); Description = 'Plan the deploy' }",
  );
  // Nested paths are keyed below the main command.
  nodeBlock(script, "deploy plan");
});

Deno.test("generatePowerShellCompletions: records options with value flags and completion actions", () => {
  const script = generatePowerShellCompletions("tool", sampleTree());
  const deploy = nodeBlock(script, "deploy");
  // Global options are inherited by subcommands.
  assertStringIncludes(
    deploy,
    "@{ Flags = @('--verbose'); TakesValue = $false; Action = ''; File = $false; Description = 'Show more' }",
  );
  assertStringIncludes(
    deploy,
    "@{ Flags = @('--from'); TakesValue = $true; Action = 'thing_name'; File = $false; Description = 'Source thing' }",
  );
  assertStringIncludes(
    deploy,
    "@{ Flags = @('--config'); TakesValue = $true; Action = ''; File = $true; Description = 'Config file' }",
  );
  // An optional value does not consume the next word.
  assertStringIncludes(
    deploy,
    "@{ Flags = @('--tag'); TakesValue = $false;",
  );
  assertEquals(deploy.includes("--internal"), false);
});

Deno.test("generatePowerShellCompletions: plain string values do not call the binary", () => {
  const script = generatePowerShellCompletions("tool", sampleTree());
  assertStringIncludes(
    nodeBlock(script, "deploy"),
    "@{ Flags = @('--target'); TakesValue = $true; Action = ''; File = $false;",
  );
  assertStringIncludes(
    nodeBlock(script, "deploy plan"),
    "Arguments = @(@{ Action = ''; File = $false; Variadic = $false })",
  );
});

Deno.test("generatePowerShellCompletions: records positional arguments per index", () => {
  const script = generatePowerShellCompletions("tool", sampleTree());
  assertStringIncludes(
    nodeBlock(script, "deploy"),
    "Arguments = @(@{ Action = 'thing_name'; File = $false; Variadic = $false }, @{ Action = ''; File = $true; Variadic = $true })",
  );
});

Deno.test("generatePowerShellCompletions: dynamic values come from completions complete and are quoted, never evaluated", () => {
  const script = generatePowerShellCompletions("tool", sampleTree());
  assertStringIncludes(
    script,
    "& $commandName 'completions' 'complete' $value.Action @words 2>$null",
  );
  assertStringIncludes(
    script,
    `$completion = "'" + $text.Replace("'", "''") + "'"`,
  );
  assertEquals(script.includes("Invoke-Expression $"), false);
});

Deno.test("generatePowerShellCompletions: skips inline option values and stops reading options after --", () => {
  const script = generatePowerShellCompletions("tool", sampleTree());
  assertStringIncludes(script, "if ($word.Contains('=')) { continue }");
  assertStringIncludes(
    script,
    "if (-not $endOfOptions -and $word -eq '--') {",
  );
});

Deno.test("completionCommand: offers powershell beside bash, fish and zsh", () => {
  assertEquals(
    completionCommand.getCommands(false).map((c) => c.getName()).sort(),
    ["bash", "fish", "powershell", "zsh"],
  );
});

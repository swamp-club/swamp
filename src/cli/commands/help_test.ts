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
import { Command } from "@cliffy/command";
import type { CliSchema } from "../cli_schema.ts";
import { createHelpCommand } from "./help.ts";

/** A small tree with an aliased command and a hidden one, plus help itself. */
function buildTree() {
  const root = new Command().name("cli").description("root");
  root.command(
    "model",
    new Command().description("models").command(
      "list",
      new Command().description("list models").alias("ls"),
    ),
  );
  root.command("secret", new Command().description("secret").hidden());
  const help = createHelpCommand(root);
  root.command("help", help);
  return help;
}

/** Runs the help command and returns the schema it printed. */
async function runHelp(args: string[]): Promise<CliSchema> {
  const help = buildTree();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await help.parse(args);
  } finally {
    console.log = originalLog;
  }
  assertEquals(logs.length, 1);
  return JSON.parse(logs[0]) as CliSchema;
}

Deno.test("createHelpCommand has description", () => {
  const root = new Command().name("cli").description("root");
  const helpCmd = createHelpCommand(root);
  assertEquals(
    helpCmd.getDescription(),
    "Output full CLI schema for AI agent consumption",
  );
});

Deno.test("createHelpCommand is hidden", () => {
  const root = new Command().name("cli").description("root");
  root.command("help", createHelpCommand(root));
  const visible = root.getCommands(false);
  const helpVisible = visible.find((c) => c.getName() === "help");
  assertEquals(helpVisible, undefined);
});

Deno.test("createHelpCommand accepts variadic command path", () => {
  const root = new Command().name("cli").description("root");
  const helpCmd = createHelpCommand(root);
  const args = helpCmd.getArguments();
  assertEquals(args.length, 1);
  assertEquals(args[0].name, "command");
  assertEquals(args[0].variadic, true);
});

Deno.test("createHelpCommand resolves an alias path to the command it names", async () => {
  const schema = await runHelp(["model", "ls"]);
  assertEquals(schema.root.name, "list");
  assertEquals(schema.root.aliases, ["ls"]);
});

Deno.test("createHelpCommand omits hidden commands by default", async () => {
  const schema = await runHelp([]);
  assertEquals(schema.root.subcommands.map((c) => c.name), ["model"]);
});

Deno.test("createHelpCommand --include-hidden lists hidden commands", async () => {
  const schema = await runHelp(["--include-hidden"]);
  assertEquals(
    schema.root.subcommands.map((c) => [c.name, c.hidden]),
    [["model", false], ["secret", true], ["help", true]],
  );
});

Deno.test("createHelpCommand --include-hidden applies to a subtree", async () => {
  const schema = await runHelp(["secret", "--include-hidden"]);
  assertEquals(schema.root.name, "secret");
  assertEquals(schema.root.hidden, true);
});

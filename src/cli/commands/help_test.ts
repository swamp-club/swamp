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
import { createHelpCommand } from "./help.ts";

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

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

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("accessGroupCommand: module loads", async () => {
  const { accessGroupCommand } = await import("./access_group.ts");
  assertEquals(accessGroupCommand.getName(), "group");
});

Deno.test("accessGroupCommand: has correct description", async () => {
  const { accessGroupCommand } = await import("./access_group.ts");
  assertEquals(
    accessGroupCommand.getDescription(),
    "Manage local groups",
  );
});

Deno.test("accessGroupCommand: has create subcommand", async () => {
  const { accessGroupCommand } = await import("./access_group.ts");
  const commands = accessGroupCommand.getCommands();
  const cmd = commands.find((c) => c.getName() === "create");
  assertEquals(cmd !== undefined, true);
});

Deno.test("accessGroupCommand: has add-member subcommand", async () => {
  const { accessGroupCommand } = await import("./access_group.ts");
  const commands = accessGroupCommand.getCommands();
  const cmd = commands.find((c) => c.getName() === "add-member");
  assertEquals(cmd !== undefined, true);
});

Deno.test("accessGroupCommand: has remove-member subcommand", async () => {
  const { accessGroupCommand } = await import("./access_group.ts");
  const commands = accessGroupCommand.getCommands();
  const cmd = commands.find((c) => c.getName() === "remove-member");
  assertEquals(cmd !== undefined, true);
});

Deno.test("accessGroupCommand: has list subcommand", async () => {
  const { accessGroupCommand } = await import("./access_group.ts");
  const commands = accessGroupCommand.getCommands();
  const cmd = commands.find((c) => c.getName() === "list");
  assertEquals(cmd !== undefined, true);
});

Deno.test("accessGroupCommand: has members subcommand", async () => {
  const { accessGroupCommand } = await import("./access_group.ts");
  const commands = accessGroupCommand.getCommands();
  const cmd = commands.find((c) => c.getName() === "members");
  assertEquals(cmd !== undefined, true);
});

Deno.test("accessGroupCommand: create accepts name argument", async () => {
  const { accessGroupCommand } = await import("./access_group.ts");
  const commands = accessGroupCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const args = createCmd.getArguments();
  assertEquals(args.length, 1);
});

Deno.test("accessGroupCommand: add-member accepts group and principal arguments", async () => {
  const { accessGroupCommand } = await import("./access_group.ts");
  const commands = accessGroupCommand.getCommands();
  const addCmd = commands.find((c) => c.getName() === "add-member")!;
  const args = addCmd.getArguments();
  assertEquals(args.length, 2);
});

Deno.test("accessGroupCommand: members accepts name argument", async () => {
  const { accessGroupCommand } = await import("./access_group.ts");
  const commands = accessGroupCommand.getCommands();
  const membersCmd = commands.find((c) => c.getName() === "members")!;
  const args = membersCmd.getArguments();
  assertEquals(args.length, 1);
});

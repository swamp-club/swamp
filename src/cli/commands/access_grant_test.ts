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

import { assertEquals, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("accessGrantCommand: module loads", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  assertEquals(accessGrantCommand.getName(), "grant");
});

Deno.test("accessGrantCommand: has correct description", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  assertEquals(
    accessGrantCommand.getDescription(),
    "Manage authorization grants",
  );
});

Deno.test("accessGrantCommand: has create subcommand", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create");
  assertEquals(createCmd !== undefined, true);
});

Deno.test("accessGrantCommand: has list subcommand", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const listCmd = commands.find((c) => c.getName() === "list");
  assertEquals(listCmd !== undefined, true);
});

Deno.test("accessGrantCommand: has revoke subcommand", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const revokeCmd = commands.find((c) => c.getName() === "revoke");
  assertEquals(revokeCmd !== undefined, true);
});

Deno.test("accessGrantCommand: create has --subject option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const subjectOpt = options.find((o) => o.name === "subject");
  assertEquals(subjectOpt !== undefined, true);
});

Deno.test("accessGrantCommand: create has --allow option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const allowOpt = options.find((o) => o.name === "allow");
  assertEquals(allowOpt !== undefined, true);
});

Deno.test("accessGrantCommand: create has --deny option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const denyOpt = options.find((o) => o.name === "deny");
  assertEquals(denyOpt !== undefined, true);
});

Deno.test("accessGrantCommand: create has --on option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const onOpt = options.find((o) => o.name === "on");
  assertEquals(onOpt !== undefined, true);
});

Deno.test("accessGrantCommand: create has --when option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const whenOpt = options.find((o) => o.name === "when");
  assertEquals(whenOpt !== undefined, true);
});

Deno.test("accessGrantCommand: revoke accepts grant_id argument", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const revokeCmd = commands.find((c) => c.getName() === "revoke")!;
  const args = revokeCmd.getArguments();
  assertEquals(args.length, 1);
});

Deno.test("parseResourceFlag: parses workflow resource", async () => {
  const { parseResourceFlag } = await import("./access_grant.ts");
  const result = parseResourceFlag("workflow:@acme/*");
  assertEquals(result.kind, "workflow");
  assertEquals(result.pattern, "@acme/*");
});

Deno.test("parseResourceFlag: parses model resource", async () => {
  const { parseResourceFlag } = await import("./access_grant.ts");
  const result = parseResourceFlag("model:@acme/deploy");
  assertEquals(result.kind, "model");
  assertEquals(result.pattern, "@acme/deploy");
});

Deno.test("parseResourceFlag: preserves colons in pattern", async () => {
  const { parseResourceFlag } = await import("./access_grant.ts");
  const result = parseResourceFlag("data:ns:name");
  assertEquals(result.kind, "data");
  assertEquals(result.pattern, "ns:name");
});

Deno.test("parseResourceFlag: throws on missing colon", async () => {
  const { parseResourceFlag } = await import("./access_grant.ts");
  assertThrows(
    () => parseResourceFlag("invalid"),
    Error,
    "expected format",
  );
});

Deno.test("parseResourceFlag: throws on invalid kind", async () => {
  const { parseResourceFlag } = await import("./access_grant.ts");
  assertThrows(
    () => parseResourceFlag("unknown:pattern"),
    Error,
    "Invalid resource kind",
  );
});

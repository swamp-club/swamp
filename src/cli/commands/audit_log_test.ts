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

Deno.test("auditLogCommand: module loads", async () => {
  const { auditLogCommand } = await import("./audit_log.ts");
  assertEquals(auditLogCommand.getName(), "log");
});

Deno.test("auditLogCommand: has correct description", async () => {
  const { auditLogCommand } = await import("./audit_log.ts");
  assertEquals(auditLogCommand.getDescription(), "Query the serve audit log");
});

Deno.test("auditLogCommand: has --since option", async () => {
  const { auditLogCommand } = await import("./audit_log.ts");
  const options = auditLogCommand.getOptions();
  const opt = options.find((o) => o.name === "since");
  assertEquals(opt !== undefined, true);
});

Deno.test("auditLogCommand: has --until option", async () => {
  const { auditLogCommand } = await import("./audit_log.ts");
  const options = auditLogCommand.getOptions();
  const opt = options.find((o) => o.name === "until");
  assertEquals(opt !== undefined, true);
});

Deno.test("auditLogCommand: has --principal option", async () => {
  const { auditLogCommand } = await import("./audit_log.ts");
  const options = auditLogCommand.getOptions();
  const opt = options.find((o) => o.name === "principal");
  assertEquals(opt !== undefined, true);
});

Deno.test("auditLogCommand: has --category option", async () => {
  const { auditLogCommand } = await import("./audit_log.ts");
  const options = auditLogCommand.getOptions();
  const opt = options.find((o) => o.name === "category");
  assertEquals(opt !== undefined, true);
});

Deno.test("auditLogCommand: has --action option", async () => {
  const { auditLogCommand } = await import("./audit_log.ts");
  const options = auditLogCommand.getOptions();
  const opt = options.find((o) => o.name === "action");
  assertEquals(opt !== undefined, true);
});

Deno.test("auditLogCommand: has --outcome option", async () => {
  const { auditLogCommand } = await import("./audit_log.ts");
  const options = auditLogCommand.getOptions();
  const opt = options.find((o) => o.name === "outcome");
  assertEquals(opt !== undefined, true);
});

Deno.test("auditLogCommand: has --limit option", async () => {
  const { auditLogCommand } = await import("./audit_log.ts");
  const options = auditLogCommand.getOptions();
  const opt = options.find((o) => o.name === "limit");
  assertEquals(opt !== undefined, true);
});

Deno.test("auditLogCommand: is registered as subcommand of audit", async () => {
  const { auditCommand } = await import("./audit.ts");
  const commands = auditCommand.getCommands();
  const logCmd = commands.find((c) => c.getName() === "log");
  assertEquals(logCmd !== undefined, true);
});

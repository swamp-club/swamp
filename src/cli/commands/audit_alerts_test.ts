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

Deno.test("auditAlertsCommand: module loads", async () => {
  const { auditAlertsCommand } = await import("./audit_alerts.ts");
  assertEquals(auditAlertsCommand.getName(), "alerts");
});

Deno.test("auditAlertsCommand: has correct description", async () => {
  const { auditAlertsCommand } = await import("./audit_alerts.ts");
  assertEquals(
    auditAlertsCommand.getDescription(),
    "List active audit alert rules and their current state",
  );
});

Deno.test("auditAlertsCommand: is registered as subcommand of audit", async () => {
  const { auditCommand } = await import("./audit.ts");
  const commands = auditCommand.getCommands();
  const alertsCmd = commands.find((c) => c.getName() === "alerts");
  assertEquals(alertsCmd !== undefined, true);
});

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

Deno.test("auditRotateKeyCommand: module loads", async () => {
  const { auditRotateKeyCommand } = await import("./audit_rotate_key.ts");
  assertEquals(auditRotateKeyCommand.getName(), "rotate-key");
});

Deno.test("auditRotateKeyCommand: has correct description", async () => {
  const { auditRotateKeyCommand } = await import("./audit_rotate_key.ts");
  assertEquals(
    auditRotateKeyCommand.getDescription(),
    "Rotate the HMAC key used for audit event hashing",
  );
});

Deno.test("auditRotateKeyCommand: is registered as subcommand of audit", async () => {
  const { auditCommand } = await import("./audit.ts");
  const commands = auditCommand.getCommands();
  const rotateKeyCmd = commands.find((c) => c.getName() === "rotate-key");
  assertEquals(rotateKeyCmd !== undefined, true);
});

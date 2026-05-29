// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

await initializeLogging({});

Deno.test("doctorSecretsCommand module loads", async () => {
  const mod = await import("./doctor_secrets.ts");
  assertEquals(typeof mod.doctorSecretsCommand, "object");
});

Deno.test("doctorSecretsCommand is registered as subcommand of doctorCommand", async () => {
  const { doctorCommand } = await import("./doctor.ts");
  const commands = doctorCommand.getCommands();
  const secretsCmd = commands.find((c) => c.getName() === "secrets");
  assertEquals(secretsCmd !== undefined, true);
});

Deno.test("doctorSecretsCommand has --repo-dir option", async () => {
  const { doctorSecretsCommand } = await import("./doctor_secrets.ts");
  const names = doctorSecretsCommand.getOptions().map((o) => o.name);
  assertEquals(names.includes("repo-dir"), true);
});

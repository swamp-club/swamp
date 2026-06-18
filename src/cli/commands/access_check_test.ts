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

Deno.test("accessCheckCommand: module loads", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  assertEquals(accessCheckCommand.getName(), "check");
});

Deno.test("accessCheckCommand: has correct description", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  assertEquals(
    accessCheckCommand.getDescription(),
    "Explain whether a subject can perform an action on a resource",
  );
});

Deno.test("accessCheckCommand: has --subject option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "subject");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --action option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "action");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --on option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "on");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --collectives option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "collectives");
  assertEquals(opt !== undefined, true);
});

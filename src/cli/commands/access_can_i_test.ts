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

Deno.test("accessCanICommand: module loads", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  assertEquals(accessCanICommand.getName(), "can-i");
});

Deno.test("accessCanICommand: has correct description", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  assertEquals(
    accessCanICommand.getDescription(),
    "Check your own permissions against the server's grants",
  );
});

Deno.test("accessCanICommand: has --server option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "server");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCanICommand: has --action option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "action");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCanICommand: has --on option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "on");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCanICommand: has --collectives option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "collectives");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCanICommand: has --token option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "token");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCanICommand: does not have --subject option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "subject");
  assertEquals(opt, undefined);
});

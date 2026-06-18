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

Deno.test("accessReloadCommand: module loads", async () => {
  const { accessReloadCommand } = await import("./access_reload.ts");
  assertEquals(accessReloadCommand.getName(), "reload");
});

Deno.test("accessReloadCommand: has correct description", async () => {
  const { accessReloadCommand } = await import("./access_reload.ts");
  const description = accessReloadCommand.getDescription();
  assertEquals(description.includes("policy snapshot"), true);
});

Deno.test("accessReloadCommand: has --server option", async () => {
  const { accessReloadCommand } = await import("./access_reload.ts");
  const options = accessReloadCommand.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
});

Deno.test("accessReloadCommand: has --repo-dir option", async () => {
  const { accessReloadCommand } = await import("./access_reload.ts");
  const options = accessReloadCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

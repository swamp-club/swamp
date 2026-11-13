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

Deno.test("workerTokenRotateCommand requires a name argument", async () => {
  const { workerTokenRotateCommand } = await import("./worker_token_rotate.ts");
  assertEquals(workerTokenRotateCommand.getName(), "rotate");
  const args = workerTokenRotateCommand.getArguments();
  assertEquals(args.length, 1);
  assertEquals(args[0].name, "name");
});

Deno.test("workerTokenRotateCommand has an optional --duration and remote options", async () => {
  const { workerTokenRotateCommand } = await import("./worker_token_rotate.ts");
  const options = workerTokenRotateCommand.getOptions();
  const duration = options.find((o) => o.name === "duration");
  assertEquals(duration !== undefined, true);
  assertEquals(duration?.required ?? false, false);
  assertEquals(options.some((o) => o.name === "server"), true);
  assertEquals(options.some((o) => o.name === "repo-dir"), true);
});

Deno.test("workerTokenRotateCommand is registered under worker token", async () => {
  const { workerTokenCommand } = await import("./worker.ts");
  const commands = workerTokenCommand.getCommands();
  assertEquals(commands.some((c) => c.getName() === "rotate"), true);
});

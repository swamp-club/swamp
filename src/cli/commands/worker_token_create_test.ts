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

Deno.test("workerTokenCreateCommand module loads", async () => {
  const { workerTokenCreateCommand } = await import("./worker_token_create.ts");
  assertEquals(workerTokenCreateCommand.getName(), "create");
});

Deno.test("workerTokenCreateCommand has --duration as required option", async () => {
  const { workerTokenCreateCommand } = await import("./worker_token_create.ts");
  const options = workerTokenCreateCommand.getOptions();
  const durationOpt = options.find((o) => o.name === "duration");
  assertEquals(durationOpt !== undefined, true);
  assertEquals(durationOpt?.required, true);
});

Deno.test("workerTokenCreateCommand has optional --vault option", async () => {
  const { workerTokenCreateCommand } = await import("./worker_token_create.ts");
  const options = workerTokenCreateCommand.getOptions();
  const vaultOpt = options.find((o) => o.name === "vault");
  assertEquals(vaultOpt !== undefined, true);
  assertEquals(vaultOpt?.required ?? false, false);
});

Deno.test("workerTokenCreateCommand has --repo-dir option", async () => {
  const { workerTokenCreateCommand } = await import("./worker_token_create.ts");
  const options = workerTokenCreateCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

Deno.test("workerTokenCreateCommand requires a name argument", async () => {
  const { workerTokenCreateCommand } = await import("./worker_token_create.ts");
  const args = workerTokenCreateCommand.getArguments();
  assertEquals(args.length, 1);
  assertEquals(args[0].name, "name");
});

Deno.test("workerTokenCreateCommand is registered under worker token", async () => {
  const { workerTokenCommand } = await import("./worker.ts");
  const commands = workerTokenCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create");
  assertEquals(createCmd !== undefined, true);
});

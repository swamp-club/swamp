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

Deno.test("workerVerifyCommand: module loads", async () => {
  const { workerVerifyCommand } = await import("./worker_verify.ts");
  assertEquals(workerVerifyCommand.getName(), "verify");
});

Deno.test("workerVerifyCommand: has optional name argument", async () => {
  const { workerVerifyCommand } = await import("./worker_verify.ts");
  const args = workerVerifyCommand.getArguments();
  assertEquals(args.length, 1);
});

Deno.test("workerVerifyCommand: has --label option", async () => {
  const { workerVerifyCommand } = await import("./worker_verify.ts");
  const options = workerVerifyCommand.getOptions();
  const labelOpt = options.find((o) => o.name === "label");
  assertEquals(labelOpt !== undefined, true);
  assertEquals(labelOpt?.collect, true);
});

Deno.test("workerVerifyCommand: has --server option from withRemoteOptions", async () => {
  const { workerVerifyCommand } = await import("./worker_verify.ts");
  const options = workerVerifyCommand.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
});

Deno.test("workerCommand: includes verify subcommand", async () => {
  const { workerCommand } = await import("./worker.ts");
  const commands = workerCommand.getCommands();
  const names = commands.map((c) => c.getName());
  assertEquals(names.includes("verify"), true);
});

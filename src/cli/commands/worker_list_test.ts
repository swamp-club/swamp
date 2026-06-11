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

Deno.test("workerListCommand module loads", async () => {
  const { workerListCommand } = await import("./worker_list.ts");
  assertEquals(workerListCommand.getName(), "list");
});

Deno.test("workerListCommand has --repo-dir option", async () => {
  const { workerListCommand } = await import("./worker_list.ts");
  const options = workerListCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

Deno.test("workerListCommand takes no positional arguments", async () => {
  const { workerListCommand } = await import("./worker_list.ts");
  const args = workerListCommand.getArguments();
  assertEquals(args.length, 0);
});

Deno.test("workerCommand groups token and list subcommands", async () => {
  const { workerCommand } = await import("./worker.ts");
  assertEquals(workerCommand.getName(), "worker");
  const commands = workerCommand.getCommands();
  const names = commands.map((c) => c.getName());
  assertEquals(names.includes("token"), true);
  assertEquals(names.includes("list"), true);
});

Deno.test("worker token group has create, list, and revoke", async () => {
  const { workerTokenCommand } = await import("./worker.ts");
  const names = workerTokenCommand.getCommands().map((c) => c.getName());
  assertEquals(names.includes("create"), true);
  assertEquals(names.includes("list"), true);
  assertEquals(names.includes("revoke"), true);
});

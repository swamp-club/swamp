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

Deno.test("workerTokenListCommand module loads", async () => {
  const { workerTokenListCommand } = await import("./worker_token_list.ts");
  assertEquals(workerTokenListCommand.getName(), "list");
});

Deno.test("workerTokenListCommand has --repo-dir option", async () => {
  const { workerTokenListCommand } = await import("./worker_token_list.ts");
  const options = workerTokenListCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

Deno.test("workerTokenListCommand takes no positional arguments", async () => {
  const { workerTokenListCommand } = await import("./worker_token_list.ts");
  const args = workerTokenListCommand.getArguments();
  assertEquals(args.length, 0);
});

Deno.test("workerTokenListCommand is registered under worker token", async () => {
  const { workerTokenCommand } = await import("./worker.ts");
  const commands = workerTokenCommand.getCommands();
  const listCmd = commands.find((c) => c.getName() === "list");
  assertEquals(listCmd !== undefined, true);
});

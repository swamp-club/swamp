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

Deno.test("workerTokenRevokeCommand module loads", async () => {
  const { workerTokenRevokeCommand } = await import("./worker_token_revoke.ts");
  assertEquals(workerTokenRevokeCommand.getName(), "revoke");
});

Deno.test("workerTokenRevokeCommand requires a name argument", async () => {
  const { workerTokenRevokeCommand } = await import("./worker_token_revoke.ts");
  const args = workerTokenRevokeCommand.getArguments();
  assertEquals(args.length, 1);
  assertEquals(args[0].name, "name");
});

Deno.test("workerTokenRevokeCommand has --repo-dir option", async () => {
  const { workerTokenRevokeCommand } = await import("./worker_token_revoke.ts");
  const options = workerTokenRevokeCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

Deno.test("workerTokenRevokeCommand is registered under worker token", async () => {
  const { workerTokenCommand } = await import("./worker.ts");
  const commands = workerTokenCommand.getCommands();
  const revokeCmd = commands.find((c) => c.getName() === "revoke");
  assertEquals(revokeCmd !== undefined, true);
});

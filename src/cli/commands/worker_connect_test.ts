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

Deno.test("workerConnectCommand: module loads", async () => {
  const { workerConnectCommand } = await import("./worker_connect.ts");
  assertEquals(workerConnectCommand.getName(), "connect");
});

Deno.test("workerConnectCommand: has url argument", async () => {
  const { workerConnectCommand } = await import("./worker_connect.ts");
  const args = workerConnectCommand.getArguments();
  assertEquals(args.length, 1);
});

Deno.test("workerConnectCommand: --token is not required (env-var fallback)", async () => {
  const { workerConnectCommand } = await import("./worker_connect.ts");
  const options = workerConnectCommand.getOptions();
  const tokenOpt = options.find((o) => o.name === "token");
  assertEquals(tokenOpt !== undefined, true);
  assertEquals(tokenOpt?.required ?? false, false);
});

Deno.test("workerConnectCommand: --cache-dir option exists", async () => {
  const { workerConnectCommand } = await import("./worker_connect.ts");
  const options = workerConnectCommand.getOptions();
  const cacheDirOpt = options.find((o) => o.name === "cache-dir");
  assertEquals(cacheDirOpt !== undefined, true);
});

Deno.test("workerConnectCommand: --label option is collectible", async () => {
  const { workerConnectCommand } = await import("./worker_connect.ts");
  const options = workerConnectCommand.getOptions();
  const labelOpt = options.find((o) => o.name === "label");
  assertEquals(labelOpt !== undefined, true);
  assertEquals(labelOpt?.collect, true);
});

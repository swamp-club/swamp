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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("authServerLoginCommand: --server option is not required", async () => {
  const { authServerLoginCommand } = await import("./auth_server_login.ts");
  const options = authServerLoginCommand.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
  assertEquals(!!serverOpt!.required, false);
});

Deno.test("authServerLoginCommand: --server description mentions SWAMP_SERVE_URL", async () => {
  const { authServerLoginCommand } = await import("./auth_server_login.ts");
  const options = authServerLoginCommand.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
  assertStringIncludes(serverOpt!.description, "SWAMP_SERVE_URL");
});

Deno.test("parseServerLoginUrl: normalizes a valid URL", async () => {
  const { parseServerLoginUrl } = await import("./auth_server_login.ts");
  assertEquals(
    parseServerLoginUrl("wss://Serve.Example.com:443/"),
    "https://serve.example.com",
  );
});

Deno.test("parseServerLoginUrl: the invalid-URL error hides credentials", async () => {
  const { parseServerLoginUrl } = await import("./auth_server_login.ts");
  const error = assertThrows(
    () => parseServerLoginUrl("ftp://alice:hunter2@h:2121/?token=abc.s3cret"),
    UserError,
  );
  assertStringIncludes(error.message, '"ftp://h:2121"');
  for (const secret of ["alice", "hunter2", "s3cret"]) {
    assertEquals(error.message.includes(secret), false, secret);
  }
});

Deno.test("parseServerLoginUrl: the invalid-URL error omits an unparseable value", async () => {
  const { parseServerLoginUrl } = await import("./auth_server_login.ts");
  const error = assertThrows(
    () => parseServerLoginUrl("not a url s3cret"),
    UserError,
  );
  assertEquals(error.message.includes("s3cret"), false);
});

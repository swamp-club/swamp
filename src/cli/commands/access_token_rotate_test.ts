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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import { UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("accessTokenRotateCommand: module loads", async () => {
  const { accessTokenRotateCommand } = await import("./access_token_rotate.ts");
  assertEquals(accessTokenRotateCommand.getName(), "rotate");
});

Deno.test("accessTokenRotateCommand: --vault option help text mentions local repos and not supported", async () => {
  const { accessTokenRotateCommand } = await import("./access_token_rotate.ts");
  const options = accessTokenRotateCommand.getOptions();
  const vaultOpt = options.find((o) => o.name === "vault");
  assertEquals(vaultOpt !== undefined, true);
  assertEquals(vaultOpt!.description.includes("local repos only"), true);
  assertEquals(vaultOpt!.description.includes("not supported"), true);
});

Deno.test("accessTokenRotateCommand: --vault rejected when --server is set", async () => {
  const { accessTokenRotateCommand } = await import("./access_token_rotate.ts");
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("rotate", accessTokenRotateCommand);

  const error = await assertRejects(
    () =>
      root.parse([
        "rotate",
        "test-token",
        "--server",
        "ws://localhost:0",
        "--token",
        "dummy.token",
        "--vault",
        "my-vault",
      ]),
    UserError,
    "--vault is not supported when targeting a remote server",
  );
  assertStringIncludes(
    error.message,
    "swamp vault put 'my-vault' 'server-token-test-token' --yes",
  );
});

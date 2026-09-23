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

Deno.test("accessTokenMintCommand: module loads", async () => {
  const { accessTokenMintCommand } = await import("./access_token_mint.ts");
  assertEquals(accessTokenMintCommand.getName(), "mint");
});

Deno.test("accessTokenMintCommand: description does not mention vault storage", async () => {
  const { accessTokenMintCommand } = await import("./access_token_mint.ts");
  const desc = accessTokenMintCommand.getDescription();
  assertEquals(desc.includes("stored in a vault"), false);
});

Deno.test("accessTokenMintCommand: has no --vault option", async () => {
  const { accessTokenMintCommand } = await import("./access_token_mint.ts");
  const vaultOpt = accessTokenMintCommand.getOptions(true).find((o) =>
    o.name === "vault"
  );
  assertEquals(vaultOpt, undefined);
});

Deno.test("accessTokenMintCommand: rejects an unsupported principal kind before any repo work", async () => {
  const { accessTokenMintCommand } = await import("./access_token_mint.ts");
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("mint", accessTokenMintCommand);

  await assertRejects(
    () =>
      root.parse([
        "mint",
        "agent-token",
        "--principal",
        "agent:swamp-resumer",
        "--repo-dir",
        "/nonexistent-swamp-repo",
      ]),
    UserError,
    'Invalid --principal value "agent:swamp-resumer": Invalid principal kind "agent": expected "user" or "worker"',
  );
});

Deno.test("accessTokenMintCommand: rejects an unsupported principal kind before contacting --server", async () => {
  const { accessTokenMintCommand } = await import("./access_token_mint.ts");
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("mint", accessTokenMintCommand);

  await assertRejects(
    () =>
      root.parse([
        "mint",
        "agent-token",
        "--principal",
        "agent:swamp-resumer",
        "--server",
        "ws://localhost:0",
        "--token",
        "dummy.token",
      ]),
    UserError,
    'Invalid principal kind "agent"',
  );
});

Deno.test("accessTokenMintCommand: --principal help text names both valid kinds", async () => {
  const { accessTokenMintCommand } = await import("./access_token_mint.ts");
  const principalOpt = accessTokenMintCommand.getOptions().find((o) =>
    o.name === "principal"
  );
  assertStringIncludes(principalOpt!.description, "user:<id>");
  assertStringIncludes(principalOpt!.description, "worker:<id>");
});

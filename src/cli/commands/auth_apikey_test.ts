// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { authApikeyCommand } from "./auth_apikey.ts";

Deno.test("authApikeyCommand has correct name and description", () => {
  assertEquals(authApikeyCommand.getName(), "apikey");
  assertEquals(authApikeyCommand.getDescription(), "Manage API keys");
});

Deno.test("authApikeyCommand has list subcommand", () => {
  const cmd = authApikeyCommand.getCommand("list");
  assertEquals(cmd !== undefined, true);
  assertEquals(cmd!.getDescription(), "List all API keys");
});

Deno.test("authApikeyCommand has create subcommand", () => {
  const cmd = authApikeyCommand.getCommand("create");
  assertEquals(cmd !== undefined, true);
  assertEquals(cmd!.getDescription(), "Create a new API key");
});

Deno.test("authApikeyCommand has revoke subcommand", () => {
  const cmd = authApikeyCommand.getCommand("revoke");
  assertEquals(cmd !== undefined, true);
  assertEquals(cmd!.getDescription(), "Revoke (disable) an API key");
});

Deno.test("authApikeyCommand has delete subcommand", () => {
  const cmd = authApikeyCommand.getCommand("delete");
  assertEquals(cmd !== undefined, true);
  assertEquals(cmd!.getDescription(), "Permanently delete an API key");
});

Deno.test("authApikeyCommand is registered under auth command", async () => {
  const { authCommand } = await import("./auth.ts");
  const cmd = authCommand.getCommand("apikey");
  assertEquals(cmd !== undefined, true);
});

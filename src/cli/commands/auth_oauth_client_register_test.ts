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

await initializeLogging({});

Deno.test("authOAuthClientRegisterCommand is registered under auth oauth-client", async () => {
  const { authCommand, authOAuthClientCommand } = await import("./auth.ts");
  assertEquals(
    authCommand.getCommands().map((c) => c.getName()).includes("oauth-client"),
    true,
  );
  assertEquals(
    authOAuthClientCommand.getCommands().map((c) => c.getName()),
    ["register"],
  );
});

Deno.test("authOAuthClientRegisterCommand requires --name and takes --oauth-provider, never a secret", async () => {
  const { authOAuthClientRegisterCommand } = await import(
    "./auth_oauth_client_register.ts"
  );
  const options = authOAuthClientRegisterCommand.getOptions();
  const name = options.find((o) => o.flags.includes("--name"));
  assertEquals(name?.required, true);
  const flags = options.flatMap((o) => o.flags);
  assertEquals(flags.includes("--oauth-provider"), true);
  assertEquals(flags.some((f) => f.includes("secret")), false);
});

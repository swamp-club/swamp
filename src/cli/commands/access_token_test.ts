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
import { ACCESS_TOKEN_ROUTES } from "./access_routes.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("createAccessTokenCommand: keeps the group's name, description and error handler", async () => {
  const { createAccessTokenCommand } = await import("./access_token.ts");
  const group = await createAccessTokenCommand();
  assertEquals(group.getName(), "token");
  assertEquals(
    group.getDescription(),
    "Manage server tokens for user authentication",
  );
  assertEquals(group.settings.errorHandler, unknownCommandErrorHandler);
});

Deno.test("createAccessTokenCommand: no rest registers every subcommand in table order", async () => {
  const { createAccessTokenCommand } = await import("./access_token.ts");
  const names = (await createAccessTokenCommand()).getCommands(true).map((c) =>
    c.getName()
  );
  assertEquals(names, ACCESS_TOKEN_ROUTES.map((route) => route.name));
});

Deno.test("createAccessTokenCommand: a subcommand word or alias registers only that subcommand", async () => {
  const { createAccessTokenCommand } = await import("./access_token.ts");
  const names = (await createAccessTokenCommand(["--json", "list"]))
    .getCommands(true).map((c) => c.getName());
  assertEquals(names, ["list"]);
});

Deno.test("createAccessTokenCommand: an unknown word or help registers every subcommand", async () => {
  const { createAccessTokenCommand } = await import("./access_token.ts");
  for (const rest of [["lsit"], ["help", "list"], ["--help", "list"]]) {
    assertEquals(
      (await createAccessTokenCommand(rest)).getCommands(true).length,
      ACCESS_TOKEN_ROUTES.length,
      rest.join(" "),
    );
  }
});

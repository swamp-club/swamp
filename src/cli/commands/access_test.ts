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
import { ACCESS_ROUTES } from "./access_routes.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("createAccessCommand: keeps the group's name, description and error handler", async () => {
  const { createAccessCommand } = await import("./access.ts");
  const group = await createAccessCommand();
  assertEquals(group.getName(), "access");
  assertEquals(
    group.getDescription(),
    "Manage authorization policies (grants), groups, and access checks",
  );
  assertEquals(group.settings.errorHandler, unknownCommandErrorHandler);
});

Deno.test("createAccessCommand: no rest registers every subcommand in table order", async () => {
  const { createAccessCommand } = await import("./access.ts");
  const names = (await createAccessCommand()).getCommands(true).map((c) =>
    c.getName()
  );
  assertEquals(names, ACCESS_ROUTES.map((route) => route.name));
});

Deno.test("createAccessCommand: a subcommand word or alias registers only that subcommand", async () => {
  const { createAccessCommand } = await import("./access.ts");
  const names = (await createAccessCommand(["--json", "policy", "list"]))
    .getCommands(true).map((c) => c.getName());
  assertEquals(names, ["grant"]);
});

Deno.test("createAccessCommand: an unknown word or help registers every subcommand", async () => {
  const { createAccessCommand } = await import("./access.ts");
  for (const rest of [["tokn"], ["help", "grant"], ["--help", "grant"]]) {
    assertEquals(
      (await createAccessCommand(rest)).getCommands(true).length,
      ACCESS_ROUTES.length,
      rest.join(" "),
    );
  }
});

Deno.test("createAccessCommand: access token list narrows token to list", async () => {
  const { createAccessCommand } = await import("./access.ts");
  const access = await createAccessCommand(["token", "list"]);
  assertEquals(access.getCommands(true).map((c) => c.getName()), ["token"]);
  assertEquals(
    access.getCommand("token")?.getCommands(true).map((c) => c.getName()),
    ["list"],
  );
});

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
import { EXTENSION_ROUTES } from "./extension_routes.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("createExtensionCommand: keeps the group's name, description and error handler", async () => {
  const { createExtensionCommand } = await import("./extension.ts");
  const group = await createExtensionCommand();
  assertEquals(group.getName(), "extension");
  assertEquals(
    group.getDescription(),
    "Manage swamp extensions",
  );
  assertEquals(group.settings.errorHandler, unknownCommandErrorHandler);
});

Deno.test("createExtensionCommand: no rest registers every subcommand in table order", async () => {
  const { createExtensionCommand } = await import("./extension.ts");
  const names = (await createExtensionCommand()).getCommands(true).map((c) =>
    c.getName()
  );
  assertEquals(names, EXTENSION_ROUTES.map((route) => route.name));
});

Deno.test("createExtensionCommand: a subcommand word or alias registers only that subcommand", async () => {
  const { createExtensionCommand } = await import("./extension.ts");
  const names = (await createExtensionCommand(["--json", "ls"])).getCommands(
    true,
  ).map((c) => c.getName());
  assertEquals(names, ["list"]);
});

Deno.test("createExtensionCommand: an unknown word or help registers every subcommand", async () => {
  const { createExtensionCommand } = await import("./extension.ts");
  for (const rest of [["lsit"], ["help", "list"], ["--help", "list"]]) {
    assertEquals(
      (await createExtensionCommand(rest)).getCommands(true).length,
      EXTENSION_ROUTES.length,
      rest.join(" "),
    );
  }
});

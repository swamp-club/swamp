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
import { VAULT_ROUTES } from "./vault_routes.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("createVaultCommand: keeps the group's name, description and error handler", async () => {
  const { createVaultCommand } = await import("./vault.ts");
  const group = await createVaultCommand();
  assertEquals(group.getName(), "vault");
  assertEquals(
    group.getDescription(),
    "Manage vault configurations",
  );
  assertEquals(group.settings.errorHandler, unknownCommandErrorHandler);
});

Deno.test("createVaultCommand: no rest registers every subcommand in table order", async () => {
  const { createVaultCommand } = await import("./vault.ts");
  const names = (await createVaultCommand()).getCommands(true).map((c) =>
    c.getName()
  );
  assertEquals(names, VAULT_ROUTES.map((route) => route.name));
});

Deno.test("createVaultCommand: a subcommand word or alias registers only that subcommand", async () => {
  const { createVaultCommand } = await import("./vault.ts");
  const names = (await createVaultCommand(["--json", "get", "v", "k"]))
    .getCommands(true).map((c) => c.getName());
  assertEquals(names, ["get"]);
});

Deno.test("createVaultCommand: an unknown word or help registers every subcommand", async () => {
  const { createVaultCommand } = await import("./vault.ts");
  for (const rest of [["gte"], ["help", "get"], ["--help", "get"]]) {
    assertEquals(
      (await createVaultCommand(rest)).getCommands(true).length,
      VAULT_ROUTES.length,
      rest.join(" "),
    );
  }
});

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
import { DATASTORE_ROUTES } from "./datastore_routes.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("createDatastoreCommand: keeps the group's name, description and error handler", async () => {
  const { createDatastoreCommand } = await import("./datastore.ts");
  const group = await createDatastoreCommand();
  assertEquals(group.getName(), "datastore");
  assertEquals(
    group.getDescription(),
    "Manage datastore configuration",
  );
  assertEquals(group.settings.errorHandler, unknownCommandErrorHandler);
});

Deno.test("createDatastoreCommand: no rest registers every subcommand in table order", async () => {
  const { createDatastoreCommand } = await import("./datastore.ts");
  const names = (await createDatastoreCommand()).getCommands(true).map((c) =>
    c.getName()
  );
  assertEquals(names, DATASTORE_ROUTES.map((route) => route.name));
});

Deno.test("createDatastoreCommand: a subcommand word or alias registers only that subcommand", async () => {
  const { createDatastoreCommand } = await import("./datastore.ts");
  const names = (await createDatastoreCommand(["--json", "status"]))
    .getCommands(true).map((c) => c.getName());
  assertEquals(names, ["status"]);
});

Deno.test("createDatastoreCommand: an unknown word or help registers every subcommand", async () => {
  const { createDatastoreCommand } = await import("./datastore.ts");
  for (const rest of [["stauts"], ["help", "status"], ["--help", "status"]]) {
    assertEquals(
      (await createDatastoreCommand(rest)).getCommands(true).length,
      DATASTORE_ROUTES.length,
      rest.join(" "),
    );
  }
});

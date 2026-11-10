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
import { DATA_ROUTES } from "./data_routes.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("createDataCommand: module loads", async () => {
  const { createDataCommand } = await import("./data.ts");
  const dataCommand = await createDataCommand();
  assertEquals(dataCommand.getName(), "data");
});

Deno.test("createDataCommand: has correct description", async () => {
  const { createDataCommand } = await import("./data.ts");
  const dataCommand = await createDataCommand();
  assertEquals(dataCommand.getDescription(), "Manage behavior data");
});

Deno.test("createDataCommand: has all subcommands registered", async () => {
  const { createDataCommand } = await import("./data.ts");
  const dataCommand = await createDataCommand();
  const commands = dataCommand.getCommands();
  const commandNames = commands.map((c) => c.getName());

  assertEquals(commandNames.includes("get"), true);
  assertEquals(commandNames.includes("list"), true);
  assertEquals(commandNames.includes("search"), true);
  assertEquals(commandNames.includes("versions"), true);
});

Deno.test("createDataCommand: no rest registers every subcommand in table order", async () => {
  const { createDataCommand } = await import("./data.ts");
  const names = (await createDataCommand()).getCommands(true).map((c) =>
    c.getName()
  );
  assertEquals(names, DATA_ROUTES.map((route) => route.name));
});

Deno.test("createDataCommand: a subcommand word registers only that subcommand", async () => {
  const { createDataCommand } = await import("./data.ts");
  const names = (await createDataCommand(["--json", "get", "m", "x"]))
    .getCommands(true).map((c) => c.getName());
  assertEquals(names, ["get"]);
});

Deno.test("createDataCommand: an unknown word or help registers every subcommand", async () => {
  const { createDataCommand } = await import("./data.ts");
  for (const rest of [["gte"], ["help", "get"], ["--help", "get"]]) {
    assertEquals(
      (await createDataCommand(rest)).getCommands(true).length,
      DATA_ROUTES.length,
      rest.join(" "),
    );
  }
});

Deno.test("createDataCommand: is registered in CLI mod", async () => {
  const mod = await import("../mod.ts");
  assertEquals(typeof mod.runCli, "function");
});

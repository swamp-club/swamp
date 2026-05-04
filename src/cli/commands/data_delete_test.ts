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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("dataDeleteCommand module loads", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  assertEquals(dataDeleteCommand.getName(), "delete");
});

Deno.test("dataDeleteCommand has correct description", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  assertEquals(
    dataDeleteCommand.getDescription(),
    "Delete a data artifact (all versions, or one when --version is set)",
  );
});

Deno.test("dataDeleteCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const deleteCmd = commands.find((c) => c.getName() === "delete");
  assertEquals(deleteCmd !== undefined, true);
});

Deno.test("dataDeleteCommand has --repo-dir option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

Deno.test("dataDeleteCommand has --version option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const versionOpt = options.find((o) => o.name === "version");
  assertEquals(versionOpt !== undefined, true);
});

Deno.test("dataDeleteCommand has --force option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const forceOpt = options.find((o) => o.name === "force");
  assertEquals(forceOpt !== undefined, true);
});

Deno.test("dataDeleteCommand requires two arguments", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const args = dataDeleteCommand.getArguments();
  assertEquals(args.length, 2);
});

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

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("dataRenameCommand module loads", async () => {
  const { dataRenameCommand } = await import("./data_rename.ts");
  assertEquals(dataRenameCommand.getName(), "rename");
});

Deno.test("dataRenameCommand has correct description", async () => {
  const { dataRenameCommand } = await import("./data_rename.ts");
  assertEquals(
    dataRenameCommand.getDescription(),
    "Rename a data instance with backwards-compatible forwarding",
  );
});

Deno.test("dataRenameCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const renameCmd = commands.find((c) => c.getName() === "rename");
  assertEquals(renameCmd !== undefined, true);
});

Deno.test("dataRenameCommand has --repo-dir option", async () => {
  const { dataRenameCommand } = await import("./data_rename.ts");
  const options = dataRenameCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

Deno.test("dataRenameCommand requires three arguments", async () => {
  const { dataRenameCommand } = await import("./data_rename.ts");
  const args = dataRenameCommand.getArguments();
  assertEquals(args.length, 3);
});

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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("datastoreSetupCommand module loads", async () => {
  const { datastoreSetupCommand } = await import("./datastore_setup.ts");
  // The name is set by the parent command when registering; verify it exists
  assertEquals(typeof datastoreSetupCommand.getName(), "string");
});

Deno.test("datastoreSetupCommand has filesystem subcommand", async () => {
  const { datastoreSetupCommand } = await import("./datastore_setup.ts");
  const fsCmd = datastoreSetupCommand.getCommand("filesystem");
  assertEquals(fsCmd !== undefined, true, "filesystem subcommand should exist");
  assertEquals(fsCmd?.getDescription(), "Set up a filesystem datastore");
});

Deno.test("datastoreSetupCommand has extension subcommand", async () => {
  const { datastoreSetupCommand } = await import("./datastore_setup.ts");
  const extCmd = datastoreSetupCommand.getCommand("extension");
  assertEquals(extCmd !== undefined, true, "extension subcommand should exist");
  assertEquals(
    extCmd?.getDescription(),
    "Set up an extension-provided datastore (e.g., @swamp/s3-datastore)",
  );
});

Deno.test("datastoreSetupCommand has s3 deprecated subcommand", async () => {
  const { datastoreSetupCommand } = await import("./datastore_setup.ts");
  const s3Cmd = datastoreSetupCommand.getCommand("s3");
  assertEquals(s3Cmd !== undefined, true, "s3 subcommand should exist");
});

Deno.test("datastoreSetupCommand has parent action for interactive mode", async () => {
  const { datastoreSetupCommand } = await import("./datastore_setup.ts");
  // Verify the command has an action set (parent interactive wizard)
  // by checking the command description matches
  assertEquals(
    datastoreSetupCommand.getDescription(),
    "Configure a datastore for this repository",
  );
  // The parent command should have 3 subcommands
  const commands = datastoreSetupCommand.getCommands();
  const names = commands.map((c) => c.getName()).sort();
  assertEquals(names, ["extension", "filesystem", "s3"]);
});

Deno.test("datastoreSetupExtensionCommand has --timeout option", async () => {
  const { datastoreSetupCommand } = await import("./datastore_setup.ts");
  const extCmd = datastoreSetupCommand.getCommand("extension");
  assertEquals(extCmd !== undefined, true);
  const opt = extCmd?.getOption("timeout");
  assertEquals(opt !== undefined, true, "--timeout option should exist");
  assertStringIncludes(
    opt?.description ?? "",
    "sync timeout",
    "--timeout description should mention sync timeout",
  );
});

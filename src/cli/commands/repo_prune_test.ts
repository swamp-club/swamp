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
import { repoPruneCommand } from "./repo_prune.ts";

await initializeLogging({});

Deno.test("repoPruneCommand is registered as a repo subcommand", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  const prune = repoCommand.getCommands().find((c) => c.getName() === "prune");
  assertEquals(prune !== undefined, true);
});

Deno.test("repoPruneCommand offers --dry-run, -y/--yes and its -f/--force alias", () => {
  assertEquals(repoPruneCommand.getOption("dry-run")?.flags, ["--dry-run"]);
  assertEquals(repoPruneCommand.getOption("yes")?.flags, ["-y", "--yes"]);
  assertEquals(repoPruneCommand.getOption("force")?.flags, ["-f", "--force"]);
});

Deno.test("repoPruneCommand takes an optional path argument", () => {
  const args = repoPruneCommand.getArguments();
  assertEquals(args.length, 1);
  assertEquals(args[0].name, "path");
  assertEquals(args[0].optional, true);
});

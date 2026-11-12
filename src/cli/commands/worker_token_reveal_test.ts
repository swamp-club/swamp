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

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("workerTokenRevealCommand takes a name, --yes, --force and remote options", async () => {
  const { workerTokenRevealCommand } = await import("./worker_token_reveal.ts");
  assertEquals(workerTokenRevealCommand.getName(), "reveal");
  assertEquals(workerTokenRevealCommand.getArguments()[0].name, "name");
  const options = workerTokenRevealCommand.getOptions().map((o) => o.name);
  for (const name of ["yes", "force", "server", "repo-dir"]) {
    assertEquals(options.includes(name), true, name);
  }
});

Deno.test("workerTokenRevealCommand is registered under worker token", async () => {
  const { workerTokenCommand } = await import("./worker.ts");
  assertEquals(
    workerTokenCommand.getCommands().some((c) => c.getName() === "reveal"),
    true,
  );
});

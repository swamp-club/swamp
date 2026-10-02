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

import { assertEquals, assertRejects } from "@std/assert";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("dataQueryCommand has --single option", async () => {
  const { dataQueryCommand } = await import("./data_query.ts");
  const option = dataQueryCommand.getOption("single");
  assertEquals(option !== undefined, true);
});

Deno.test("dataQueryCommand --single conflicts with --limit", async () => {
  const { dataQueryCommand } = await import("./data_query.ts");
  assertEquals(dataQueryCommand.getOption("single")?.conflicts, ["limit"]);
});

Deno.test("dataQueryCommand: --single without a predicate fails before opening the TUI", async () => {
  const { dataQueryCommand } = await import("./data_query.ts");
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("query", dataQueryCommand);

  await assertRejects(
    () => root.parse(["query", "--single"]),
    UserError,
    "A CEL predicate is required with --single",
  );
});

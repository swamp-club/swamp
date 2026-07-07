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

Deno.test("dataPruneCommand - has correct name", async () => {
  const { dataPruneCommand } = await import("./data_prune.ts");
  assertEquals(dataPruneCommand.getName(), "prune");
});

Deno.test("dataPruneCommand - description mentions orphaned data", async () => {
  const { dataPruneCommand } = await import("./data_prune.ts");
  const description = dataPruneCommand.getDescription().toLowerCase();
  assertStringIncludes(description, "orphaned");
});

Deno.test("dataPruneCommand - description distinguishes it from gc", async () => {
  const { dataPruneCommand } = await import("./data_prune.ts");
  const description = dataPruneCommand.getDescription().toLowerCase();
  assertStringIncludes(description, "gc");
});

Deno.test("dataPruneCommand - has repo-dir option", async () => {
  const { dataPruneCommand } = await import("./data_prune.ts");
  const options = dataPruneCommand.getOptions();
  const repoDir = options.find((opt) => opt.name === "repo-dir");
  assertEquals(repoDir !== undefined, true);
});

Deno.test("dataPruneCommand - has dry-run option", async () => {
  const { dataPruneCommand } = await import("./data_prune.ts");
  const options = dataPruneCommand.getOptions();
  const dryRun = options.find((opt) => opt.name === "dry-run");
  assertEquals(dryRun !== undefined, true);
});

Deno.test("dataPruneCommand - has force option", async () => {
  const { dataPruneCommand } = await import("./data_prune.ts");
  const options = dataPruneCommand.getOptions();
  const force = options.find((opt) => opt.name === "force");
  assertEquals(force !== undefined, true);
});

Deno.test("dataPruneCommand - help text includes a --json non-interactive example", async () => {
  const { dataPruneCommand } = await import("./data_prune.ts");
  const examples = dataPruneCommand.getExamples().map((e) => e.description);
  const hasJsonExample = examples.some((d) => d.toLowerCase().includes("json"));
  assertEquals(hasJsonExample, true, `examples were: ${examples.join(" | ")}`);
});

Deno.test("data command registers the prune subcommand", async () => {
  await import("../../domain/models/models.ts");
  const { dataCommand } = await import("./data.ts");
  const prune = dataCommand.getCommand("prune");
  assertEquals(prune !== undefined, true);
});

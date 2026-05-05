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

// Initialize logging for tests
await initializeLogging({});

Deno.test("dataGcCommand - has correct name", async () => {
  const { dataGcCommand } = await import("./data_gc.ts");
  assertEquals(dataGcCommand.getName(), "gc");
});

Deno.test("dataGcCommand - has description", async () => {
  const { dataGcCommand } = await import("./data_gc.ts");
  const description = dataGcCommand.getDescription();
  assertEquals(
    description,
    "Run garbage collection on data (lifecycle and versions)",
  );
});

Deno.test("dataGcCommand - has repo-dir option", async () => {
  const { dataGcCommand } = await import("./data_gc.ts");
  const options = dataGcCommand.getOptions();
  const repoDir = options.find((opt) => opt.name === "repo-dir");
  assertEquals(repoDir !== undefined, true);
});

Deno.test("dataGcCommand - has dry-run option", async () => {
  const { dataGcCommand } = await import("./data_gc.ts");
  const options = dataGcCommand.getOptions();
  const dryRun = options.find((opt) => opt.name === "dry-run");
  assertEquals(dryRun !== undefined, true);
});

Deno.test("dataGcCommand - has force option", async () => {
  const { dataGcCommand } = await import("./data_gc.ts");
  const options = dataGcCommand.getOptions();
  const force = options.find((opt) => opt.name === "force");
  assertEquals(force !== undefined, true);
});

Deno.test("dataGcCommand - help text includes a --json non-interactive example", async () => {
  // swamp-club#235 — agentic users need to discover that JSON mode
  // bypasses the interactive prompt without reading source.
  const { dataGcCommand } = await import("./data_gc.ts");
  const examples = dataGcCommand.getExamples().map((e) => e.description);
  const hasJsonExample = examples.some((d) => d.toLowerCase().includes("json"));
  assertEquals(hasJsonExample, true, `examples were: ${examples.join(" | ")}`);
});

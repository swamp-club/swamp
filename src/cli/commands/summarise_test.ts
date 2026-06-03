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

Deno.test("summariseCommand module loads", async () => {
  const { summariseCommand } = await import("./summarise.ts");
  assertEquals(summariseCommand.getName(), "summarise");
});

Deno.test("summariseCommand has correct description", async () => {
  const { summariseCommand } = await import("./summarise.ts");
  assertEquals(
    summariseCommand.getDescription(),
    "Show a high-level overview of repo activity (method executions, workflows, data)",
  );
});

Deno.test("summariseCommand has --since option with default 7d", async () => {
  const { summariseCommand } = await import("./summarise.ts");
  const options = summariseCommand.getOptions();
  const since = options.find((o) => o.name === "since");
  assertEquals(since !== undefined, true);
  assertEquals(since!.default, "7d");
});

Deno.test("summariseCommand has --limit option (opt-in, no default)", async () => {
  const { summariseCommand } = await import("./summarise.ts");
  const options = summariseCommand.getOptions();
  const limit = options.find((o) => o.name === "limit");
  assertEquals(limit !== undefined, true);
  // Default is unlimited — no `default` set on the option, preserving the
  // pre-issue-240 JSON shape for callers who don't opt in.
  assertEquals(limit!.default, undefined);
});

Deno.test("summariseCommand exposes the summarize alias", async () => {
  const { summariseCommand } = await import("./summarise.ts");
  assertEquals(summariseCommand.getAliases().includes("summarize"), true);
});

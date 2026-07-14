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

await initializeLogging({});

Deno.test("workflowResumeCommand has --timeout option (swamp-club#1136)", async () => {
  const { workflowResumeCommand } = await import("./workflow_resume.ts");
  const names = workflowResumeCommand.getOptions().map((o) => o.name);
  if (!names.includes("timeout")) {
    throw new Error(
      `expected --timeout option, got: ${names.join(", ")}`,
    );
  }
});

Deno.test("workflowResumeCommand --timeout description matches workflow run", async () => {
  const { workflowResumeCommand } = await import("./workflow_resume.ts");
  const options = workflowResumeCommand.getOptions();
  const timeoutOpt = options.find((o) => o.name === "timeout");
  assertEquals(timeoutOpt !== undefined, true);
  assertEquals(
    timeoutOpt!.description,
    "Cancellation deadline — seconds (e.g. 30, 1800) or duration string (e.g. 30s, 5m, 1h). Cooperative — only honored by methods that check AbortSignal.",
  );
});

Deno.test("workflowResumeCommand has --server option", async () => {
  const { workflowResumeCommand } = await import("./workflow_resume.ts");
  const options = workflowResumeCommand.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
});

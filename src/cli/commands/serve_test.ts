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

Deno.test("serveCommand module loads", async () => {
  const { serveCommand } = await import("./serve.ts");
  assertEquals(serveCommand.getName(), "serve");
});

Deno.test("serveCommand has correct description", async () => {
  const { serveCommand } = await import("./serve.ts");
  assertEquals(
    serveCommand.getDescription(),
    "Start a WebSocket API server for workflow and model execution",
  );
});

Deno.test("serveCommand has --port option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const portOpt = options.find((o) => o.name === "port");
  assertEquals(portOpt !== undefined, true);
});

Deno.test("serveCommand has --host option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const hostOpt = options.find((o) => o.name === "host");
  assertEquals(hostOpt !== undefined, true);
});

Deno.test("serveCommand has --repo-dir option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { assertOffLoopbackSecurity } from "./serve.ts";
import { UserError } from "../../domain/errors.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("serveCommand module loads", async () => {
  const { serveCommand } = await import("./serve.ts");
  assertEquals(serveCommand.getName(), "serve");
});

Deno.test("serveCommand has correct description", async () => {
  const { serveCommand } = await import("./serve.ts");
  const description = serveCommand.getDescription();
  assertStringIncludes(
    description,
    "Start a WebSocket API server for workflow and model execution",
  );
  // Service deployments need HOME set; the description documents this so the
  // guidance is discoverable via `swamp serve --help` (see swamp-club#463).
  assertStringIncludes(description, "HOME");
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

Deno.test("serveCommand has --cert-file option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const certOpt = options.find((o) => o.name === "cert-file");
  assertEquals(certOpt !== undefined, true);
});

Deno.test("serveCommand has --key-file option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const keyOpt = options.find((o) => o.name === "key-file");
  assertEquals(keyOpt !== undefined, true);
});

// --- Off-loopback security validation ---

Deno.test("assertOffLoopbackSecurity: off-loopback without TLS refuses", () => {
  assertThrows(
    () => assertOffLoopbackSecurity("0.0.0.0", false, "none"),
    UserError,
    "Off-loopback binding requires TLS",
  );
});

Deno.test("assertOffLoopbackSecurity: off-loopback with TLS but no auth refuses", () => {
  assertThrows(
    () => assertOffLoopbackSecurity("0.0.0.0", true, "none"),
    UserError,
    "Off-loopback binding requires authentication",
  );
});

Deno.test("assertOffLoopbackSecurity: off-loopback without TLS but with auth refuses", () => {
  assertThrows(
    () => assertOffLoopbackSecurity("0.0.0.0", false, "token"),
    UserError,
    "Off-loopback binding requires TLS",
  );
});

Deno.test("assertOffLoopbackSecurity: off-loopback with TLS and auth passes", () => {
  assertOffLoopbackSecurity("0.0.0.0", true, "token");
});

Deno.test("assertOffLoopbackSecurity: loopback 127.0.0.1 with no TLS and no auth passes", () => {
  assertOffLoopbackSecurity("127.0.0.1", false, "none");
});

Deno.test("assertOffLoopbackSecurity: loopback localhost with no TLS and no auth passes", () => {
  assertOffLoopbackSecurity("localhost", false, "none");
});

Deno.test("assertOffLoopbackSecurity: IPv6 loopback ::1 with no TLS and no auth passes", () => {
  assertOffLoopbackSecurity("::1", false, "none");
});

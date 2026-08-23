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
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

/**
 * In-process serve endpoint answering every request frame with the given
 * payload — enough to drive the command's request/response --server path
 * without a subprocess.
 */
function payloadServer(
  payload: Record<string, unknown>,
): { url: string; shutdown: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => {
        const request = JSON.parse(event.data as string) as {
          type: string;
          id: string;
        };
        socket.send(
          JSON.stringify({ type: request.type, id: request.id, payload }),
        );
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
  };
}

/** Runs `access check` against a scripted server payload; returns Deno.exitCode. */
async function runAccessCheckAgainst(
  decisions: Record<string, unknown>[],
): Promise<number> {
  const server = payloadServer({
    subject: "user:adam",
    action: "run",
    resource: "workflow:@acme/deploy",
    collectives: [],
    groups: [],
    decisions,
  });
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    const { accessCheckCommand } = await import("./access_check.ts");
    const root = new Command()
      .globalOption("--json", "JSON output")
      .command("check", accessCheckCommand);
    await root.parse([
      "check",
      "--json",
      "--server",
      server.url,
      "--token",
      "test.token",
      "--subject",
      "user:adam",
      "--action",
      "run",
      "--on",
      "workflow:@acme/deploy",
    ]);
    return Deno.exitCode;
  } finally {
    Deno.exitCode = previousExitCode;
    await server.shutdown();
  }
}

Deno.test("accessCheckCommand: module loads", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  assertEquals(accessCheckCommand.getName(), "check");
});

Deno.test("accessCheckCommand: has correct description", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  assertEquals(
    accessCheckCommand.getDescription(),
    "Explain whether a subject can perform an action on a resource",
  );
});

Deno.test("accessCheckCommand: has --subject option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "subject");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --action option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "action");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --on option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "on");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --collectives option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "collectives");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --server option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "server");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --field option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "field");
  assertEquals(opt !== undefined, true);
});

Deno.test({
  name: "accessCheckCommand: sets Deno.exitCode 1 when access is denied",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await runAccessCheckAgainst([]), 1);
  },
});

Deno.test({
  name:
    "accessCheckCommand: sets Deno.exitCode 1 when the first decision denies",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(
      await runAccessCheckAgainst([
        { effect: "deny", grantId: "grant-1" },
      ]),
      1,
    );
  },
});

Deno.test({
  name: "accessCheckCommand: leaves Deno.exitCode 0 when access is allowed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(
      await runAccessCheckAgainst([
        { effect: "allow", grantId: "grant-1" },
      ]),
      0,
    );
  },
});

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

Deno.test("accessCanICommand: module loads", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  assertEquals(accessCanICommand.getName(), "can-i");
});

Deno.test("accessCanICommand: has correct description", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  assertEquals(
    accessCanICommand.getDescription(),
    "Check your own permissions against the server's grants",
  );
});

Deno.test("accessCanICommand: has --server option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "server");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCanICommand: has --action option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "action");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCanICommand: has --on option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "on");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCanICommand: has --collectives option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "collectives");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCanICommand: has --token option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "token");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCanICommand: does not have --subject option", async () => {
  const { accessCanICommand } = await import("./access_can_i.ts");
  const options = accessCanICommand.getOptions();
  const opt = options.find((o) => o.name === "subject");
  assertEquals(opt, undefined);
});

Deno.test({
  name: "accessCanICommand: sets Deno.exitCode 1 when the query is denied",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = payloadServer({ principal: "user:adam", decisions: [] });
    const previousExitCode = Deno.exitCode;
    Deno.exitCode = 0;
    try {
      const { accessCanICommand } = await import("./access_can_i.ts");
      const root = new Command()
        .globalOption("--json", "JSON output")
        .command("can-i", accessCanICommand);
      await root.parse([
        "can-i",
        "--json",
        "--server",
        server.url,
        "--token",
        "test.token",
        "--action",
        "run",
        "--on",
        "workflow:@acme/deploy",
      ]);
      assertEquals(Deno.exitCode, 1);
    } finally {
      Deno.exitCode = previousExitCode;
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "accessCanICommand: leaves Deno.exitCode 0 when the query is allowed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = payloadServer({
      principal: "user:adam",
      decisions: [
        {
          action: "run",
          resource: "workflow:@acme/deploy",
          effect: "allow",
          grantId: "grant-1",
          via: "direct",
        },
      ],
    });
    const previousExitCode = Deno.exitCode;
    Deno.exitCode = 0;
    try {
      const { accessCanICommand } = await import("./access_can_i.ts");
      const root = new Command()
        .globalOption("--json", "JSON output")
        .command("can-i", accessCanICommand);
      await root.parse([
        "can-i",
        "--json",
        "--server",
        server.url,
        "--token",
        "test.token",
        "--action",
        "run",
        "--on",
        "workflow:@acme/deploy",
      ]);
      assertEquals(Deno.exitCode, 0);
    } finally {
      Deno.exitCode = previousExitCode;
      await server.shutdown();
    }
  },
});

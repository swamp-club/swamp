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
import { Command } from "@cliffy/command";
import { ModelNameType } from "../completion_types.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

// Note: Full CLI integration tests are in integration/echo_model_test.ts
// These tests verify the command module loads correctly

Deno.test("modelMethodRunCommand module loads", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  assertEquals(modelMethodRunCommand.getName(), "run");
});

Deno.test("modelMethodRunCommand has correct description", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  const desc = modelMethodRunCommand.getDescription();
  assertStringIncludes(
    desc,
    "Execute a method on a model. With @type prefix, auto-creates the definition if needed.",
  );
  assertStringIncludes(desc, "lock_timeout");
  assertStringIncludes(desc, "Exit codes:");
});

Deno.test("modelMethodCommand module loads", async () => {
  const { modelMethodCommand } = await import("./model_method_run.ts");
  assertEquals(modelMethodCommand.getName(), "method");
});

Deno.test("modelMethodCommand has correct description", async () => {
  const { modelMethodCommand } = await import("./model_method_run.ts");
  assertEquals(
    modelMethodCommand.getDescription(),
    "Execute model methods",
  );
});

Deno.test("modelMethodCommand has run as subcommand", async () => {
  const { modelMethodCommand } = await import("./model_method_run.ts");
  const commands = modelMethodCommand.getCommands();
  const runCommand = commands.find((cmd) => cmd.getName() === "run");
  assertEquals(runCommand !== undefined, true);
});

Deno.test("modelMethodRunCommand has --timeout option (swamp-club#235)", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  const names = modelMethodRunCommand.getOptions().map((o) => o.name);
  if (!names.includes("timeout")) {
    throw new Error(
      `expected --timeout option, got: ${names.join(", ")}`,
    );
  }
});

Deno.test("modelMethodRunCommand has --server option", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  const options = modelMethodRunCommand.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
});

/**
 * In-process serve endpoint streaming the given run events followed by a
 * `done` frame — enough to drive the command's streaming --server path
 * without a subprocess.
 */
function runEventServer(
  events: Record<string, unknown>[],
): { url: string; shutdown: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const request = JSON.parse(message.data as string) as { id: string };
        for (const event of events) {
          socket.send(
            JSON.stringify({ type: "event", id: request.id, event }),
          );
        }
        socket.send(JSON.stringify({ type: "done", id: request.id }));
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
  };
}

/** Runs `model method run --server` against a scripted run result; returns Deno.exitCode. */
async function runMethodRunAgainst(
  run: Record<string, unknown>,
): Promise<number> {
  const server = runEventServer([{ kind: "completed", run }]);
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    const { modelMethodRunCommand } = await import("./model_method_run.ts");
    const root = new Command()
      .globalType("model_name", new ModelNameType())
      .globalOption("--json", "JSON output")
      .command("run", modelMethodRunCommand);
    await root.parse([
      "run",
      "echo-model",
      "echo",
      "--json",
      "--server",
      server.url,
      "--token",
      "test.token",
    ]);
    return Deno.exitCode;
  } finally {
    Deno.exitCode = previousExitCode;
    await server.shutdown();
  }
}

Deno.test({
  name:
    "modelMethodRunCommand: sets Deno.exitCode 1 when the server-side run fails",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await runMethodRunAgainst({ status: "failed" }), 1);
  },
});

Deno.test({
  name:
    "modelMethodRunCommand: leaves Deno.exitCode 0 when the server-side run succeeds",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await runMethodRunAgainst({ status: "succeeded" }), 0);
  },
});

/**
 * Captures the payload sent over the WebSocket by the --server path.
 */
function payloadCapturingServer(): {
  url: string;
  shutdown: () => Promise<void>;
  payload: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const request = JSON.parse(message.data as string) as {
          id: string;
          payload: Record<string, unknown>;
        };
        captured = request.payload;
        socket.send(JSON.stringify({
          type: "event",
          id: request.id,
          event: { kind: "completed", run: { status: "succeeded" } },
        }));
        socket.send(JSON.stringify({ type: "done", id: request.id }));
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
    payload: () => captured,
  };
}

Deno.test({
  name:
    "modelMethodRunCommand: direct type execution sends typeArg and definitionName to server",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = payloadCapturingServer();
    try {
      const { modelMethodRunCommand } = await import("./model_method_run.ts");
      const root = new Command()
        .globalType("model_name", new ModelNameType())
        .globalOption("--json", "JSON output")
        .command("run", modelMethodRunCommand);
      await root.parse([
        "run",
        "@swamp/echo",
        "echo",
        "my-def",
        "--json",
        "--server",
        server.url,
        "--token",
        "test.token",
      ]);
      const payload = server.payload();
      assertEquals(payload?.typeArg, "@swamp/echo");
      assertEquals(payload?.definitionName, "my-def");
      assertEquals(payload?.modelIdOrName, "my-def");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "modelMethodRunCommand: direct type execution without definition name rejects before server call",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { modelMethodRunCommand } = await import("./model_method_run.ts");
    const root = new Command()
      .globalType("model_name", new ModelNameType())
      .globalOption("--json", "JSON output")
      .command("run", modelMethodRunCommand);
    try {
      await root.parse([
        "run",
        "@swamp/echo",
        "echo",
        "--json",
        "--server",
        "ws://localhost:9999",
        "--token",
        "test.token",
      ]);
      throw new Error("expected UserError");
    } catch (err) {
      assertStringIncludes(
        (err as Error).message,
        "Direct type execution requires a definition name",
      );
    }
  },
});

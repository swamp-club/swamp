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
import type { WorkerVerifyData } from "../../serve/protocol.ts";

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

/** Runs `worker verify` against a scripted probe result; returns Deno.exitCode. */
async function runWorkerVerifyAgainst(
  data: WorkerVerifyData,
): Promise<number> {
  const server = payloadServer({ data });
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    const { workerVerifyCommand } = await import("./worker_verify.ts");
    const root = new Command()
      .globalOption("--json", "JSON output")
      .command("verify", workerVerifyCommand);
    await root.parse([
      "verify",
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

Deno.test("workerVerifyCommand: module loads", async () => {
  const { workerVerifyCommand } = await import("./worker_verify.ts");
  assertEquals(workerVerifyCommand.getName(), "verify");
});

Deno.test("workerVerifyCommand: has optional name argument", async () => {
  const { workerVerifyCommand } = await import("./worker_verify.ts");
  const args = workerVerifyCommand.getArguments();
  assertEquals(args.length, 1);
});

Deno.test("workerVerifyCommand: has --label option", async () => {
  const { workerVerifyCommand } = await import("./worker_verify.ts");
  const options = workerVerifyCommand.getOptions();
  const labelOpt = options.find((o) => o.name === "label");
  assertEquals(labelOpt !== undefined, true);
  assertEquals(labelOpt?.collect, true);
});

Deno.test("workerVerifyCommand: has --server option from withRemoteOptions", async () => {
  const { workerVerifyCommand } = await import("./worker_verify.ts");
  const options = workerVerifyCommand.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
});

Deno.test("workerCommand: includes verify subcommand", async () => {
  const { workerCommand } = await import("./worker.ts");
  const commands = workerCommand.getCommands();
  const names = commands.map((c) => c.getName());
  assertEquals(names.includes("verify"), true);
});

Deno.test({
  name: "workerVerifyCommand: sets Deno.exitCode 1 when a worker probe fails",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(
      await runWorkerVerifyAgainst({
        workers: [
          { name: "worker-a", status: "pass" },
          { name: "worker-b", status: "fail", failures: ["query timeout"] },
        ],
        total: 2,
        passed: 1,
        failed: 1,
      }),
      1,
    );
  },
});

Deno.test({
  name: "workerVerifyCommand: leaves Deno.exitCode 0 when all probes pass",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(
      await runWorkerVerifyAgainst({
        workers: [{ name: "worker-a", status: "pass" }],
        total: 1,
        passed: 1,
        failed: 0,
      }),
      0,
    );
  },
});

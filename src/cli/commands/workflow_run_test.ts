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
import { WorkflowNameType } from "../completion_types.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("workflowRunCommand has --timeout option (swamp-club#235)", async () => {
  const { workflowRunCommand } = await import("./workflow_run.ts");
  const names = workflowRunCommand.getOptions().map((o) => o.name);
  if (!names.includes("timeout")) {
    throw new Error(
      `expected --timeout option, got: ${names.join(", ")}`,
    );
  }
});

Deno.test("workflowRunCommand has --server option", async () => {
  const { workflowRunCommand } = await import("./workflow_run.ts");
  const options = workflowRunCommand.getOptions();
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

/** Runs `workflow run --server` against a scripted run result; returns Deno.exitCode. */
async function runWorkflowRunAgainst(
  run: Record<string, unknown>,
): Promise<number> {
  const server = runEventServer([{ kind: "completed", run }]);
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    const { workflowRunCommand } = await import("./workflow_run.ts");
    const root = new Command()
      .globalType("workflow_name", new WorkflowNameType())
      .globalOption("--json", "JSON output")
      .command("run", workflowRunCommand);
    await root.parse([
      "run",
      "deploy-with-gate",
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
    "workflowRunCommand: sets Deno.exitCode 1 when the server-side run fails",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await runWorkflowRunAgainst({ status: "failed" }), 1);
  },
});

Deno.test({
  name:
    "workflowRunCommand: leaves Deno.exitCode 0 when the server-side run succeeds",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await runWorkflowRunAgainst({ status: "succeeded" }), 0);
  },
});

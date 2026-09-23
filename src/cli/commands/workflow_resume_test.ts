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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

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

/** Runs `workflow resume` against a scripted run result; returns Deno.exitCode. */
async function runWorkflowResumeAgainst(
  run: Record<string, unknown>,
): Promise<number> {
  const server = runEventServer([{ kind: "completed", run }]);
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    const { workflowResumeCommand } = await import("./workflow_resume.ts");
    const root = new Command()
      .globalOption("--json", "JSON output")
      .command("resume", workflowResumeCommand);
    await root.parse([
      "resume",
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

Deno.test("workflowResumeCommand has --from option", async () => {
  const { workflowResumeCommand } = await import("./workflow_resume.ts");
  const options = workflowResumeCommand.getOptions();
  const fromOpt = options.find((o) => o.name === "from");
  assertEquals(fromOpt !== undefined, true);
  assertEquals(
    fromOpt!.description,
    "Select the retry step in a failed run. Without --from, resume --run retries all failed steps.",
  );
});

Deno.test("workflowResumeCommand: help describes retrying a failed run by id", async () => {
  const { workflowResumeCommand } = await import("./workflow_resume.ts");
  // swamp-uat matches the start of this description.
  assertStringIncludes(
    workflowResumeCommand.getDescription(),
    "Resume a suspended workflow run",
  );
  assertStringIncludes(
    workflowResumeCommand.getDescription(),
    "retry the failed steps of a failed run named with --run",
  );
  const runOpt = workflowResumeCommand.getOptions().find((o) =>
    o.name === "run"
  );
  assertEquals(
    runOpt?.description,
    "Target a specific run ID (required to retry the failed steps of a failed run)",
  );
  const examples = workflowResumeCommand.getExamples().map((e) =>
    e.description
  );
  assertEquals(
    examples.includes("swamp workflow resume plate-assay --run abc123"),
    true,
  );
});

Deno.test({
  name:
    "workflowResumeCommand: sets Deno.exitCode 1 when the resumed run fails",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await runWorkflowResumeAgainst({ status: "failed" }), 1);
  },
});

Deno.test({
  name:
    "workflowResumeCommand: leaves Deno.exitCode 0 when the resumed run succeeds",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await runWorkflowResumeAgainst({ status: "succeeded" }), 0);
  },
});

Deno.test({
  name:
    "workflowResumeCommand: a failed remote resume prints a retry command for the same server",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const run = {
      id: "run-9",
      workflowId: "wf-1",
      workflowName: "deploy-with-gate",
      status: "failed",
      jobs: [{
        name: "deploy",
        status: "failed",
        steps: [{ name: "apply", status: "failed", error: "boom" }],
      }],
    };
    const server = runEventServer([
      {
        kind: "started",
        runId: "run-9",
        workflowName: "deploy-with-gate",
        jobs: [{ id: "deploy", stepCount: 1, dependsOn: [] }],
      },
      { kind: "completed", run },
    ]);
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    const previousExitCode = Deno.exitCode;
    try {
      const { workflowResumeCommand } = await import("./workflow_resume.ts");
      const root = new Command().command("resume", workflowResumeCommand);
      await root.parse([
        "resume",
        "deploy-with-gate",
        "--run",
        "run-9",
        "--server",
        server.url,
        "--token",
        "test.token",
      ]);
    } finally {
      console.log = originalLog;
      Deno.exitCode = previousExitCode;
      await server.shutdown();
    }
    assertStringIncludes(
      lines.join("\n"),
      `swamp workflow resume deploy-with-gate --run run-9 --server ${server.url}`,
    );
  },
});

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

/**
 * Integration tests for run-connection decoupling: runs survive
 * disconnection, clients can re-attach by run ID, and graceful
 * shutdown drains active runs.
 *
 * Uses a real serve subprocess and raw WebSocket connections.
 */

import { assertEquals, assertExists } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { initializeTestRepo } from "./test_helpers.ts";

const PROJECT_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

const CLI_LAUNCH_ARGS = [
  "run",
  "--config",
  join(PROJECT_ROOT, "deno.json"),
  "--unstable-bundle",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys",
  "--allow-net",
  join(PROJECT_ROOT, "main.ts"),
];

// ── Helpers ──────────────────────────────────────────────────────────

interface ServerMessage {
  type: string;
  id: string;
  event?: { kind: string; seq?: number; [key: string]: unknown };
  error?: { code: string; message: string };
  payload?: Record<string, unknown>;
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`WebSocket connect failed: ${e}`));
  });
}

function sendMsg(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

function collectUntil(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs: number,
): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `collectUntil timed out after ${timeoutMs}ms; collected ${messages.length} messages: ${
              JSON.stringify(messages.map((m) => m.type + ":" + m.event?.kind))
            }`,
          ),
        ),
      timeoutMs,
    );
    ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data as string);
      messages.push(msg);
      if (predicate(msg)) {
        clearTimeout(timer);
        resolve(messages);
      }
    };
  });
}

function waitForLine(
  stream: ReadableStream<Uint8Array>,
  predicate: (line: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const start = Date.now();
  return (async () => {
    try {
      while (true) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `timed out after ${timeoutMs}ms waiting for line; buffer was: ${buffer}`,
          );
        }
        const { done, value } = await reader.read();
        if (done) {
          throw new Error(
            `stream closed before predicate matched; buffer was: ${buffer}`,
          );
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (predicate(line)) {
            return line;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
}

async function createWorkflowYaml(
  repoDir: string,
  name: string,
  shellCommand: string,
): Promise<void> {
  const workflow = {
    name,
    jobs: {
      main: {
        steps: [{
          name: "run",
          task: `@command/shell.execute`,
          inputs: { run: shellCommand },
        }],
      },
    },
  };
  await Deno.writeTextFile(
    join(repoDir, "workflows", `${name}.yaml`),
    stringifyYaml(workflow as Record<string, unknown>),
  );
}

interface ServeProcess {
  child: Deno.ChildProcess;
  port: number;
  repoDir: string;
}

async function startServe(repoDir: string): Promise<ServeProcess> {
  await initializeTestRepo(repoDir);
  await createWorkflowYaml(repoDir, "fast-echo", "echo done");
  await createWorkflowYaml(repoDir, "slow-run", "sleep 4 && echo completed");

  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      ...CLI_LAUNCH_ARGS,
      "--json",
      "serve",
      "--port",
      "0",
      "--no-schedule",
    ],
    cwd: repoDir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();

  const listenLine = await waitForLine(
    child.stdout,
    (line) => line.includes('"status":"listening"'),
    15_000,
  );
  const parsed = JSON.parse(listenLine);
  const port = parsed.port as number;

  return { child, port, repoDir };
}

async function stopServe(serve: ServeProcess): Promise<void> {
  try {
    serve.child.kill("SIGINT");
  } catch {
    // Already dead
  }
  try {
    await serve.child.status;
  } catch {
    // Already consumed
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ────────────────────────────────────────────────────────────

Deno.test({
  name: "detached run: baseline — workflow completes normally with seq numbers",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-detached-baseline-",
    });
    const serve = await startServe(repoDir);
    try {
      const ws = await connectWs(serve.port);
      try {
        sendMsg(ws, {
          type: "workflow.run",
          id: "r1",
          payload: { workflowIdOrName: "fast-echo" },
        });

        const msgs = await collectUntil(
          ws,
          (m) => m.type === "done" && m.id === "r1",
          15_000,
        );

        const eventMsgs = msgs.filter((m) => m.type === "event");
        const kinds = eventMsgs.map((m) => m.event?.kind);

        assertEquals(kinds.includes("started"), true, "missing started event");
        assertEquals(
          kinds.includes("completed"),
          true,
          "missing completed event",
        );

        for (const msg of eventMsgs) {
          assertExists(msg.event?.seq, `event ${msg.event?.kind} missing seq`);
          assertEquals(
            typeof msg.event?.seq,
            "number",
            `seq is not a number on ${msg.event?.kind}`,
          );
        }

        const seqs = eventMsgs.map((m) => m.event!.seq as number);
        for (let i = 1; i < seqs.length; i++) {
          assertEquals(
            seqs[i] > seqs[i - 1],
            true,
            `seq not monotonic: ${seqs[i - 1]} -> ${seqs[i]}`,
          );
        }
      } finally {
        ws.close();
      }
    } finally {
      await stopServe(serve);
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "detached run: disconnect mid-run, workflow completes on server",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-detached-disconnect-",
    });
    const serve = await startServe(repoDir);
    try {
      const ws = await connectWs(serve.port);
      sendMsg(ws, {
        type: "workflow.run",
        id: "r1",
        payload: { workflowIdOrName: "slow-run" },
      });

      await collectUntil(
        ws,
        (m) => m.type === "event" && m.event?.kind === "started",
        10_000,
      );

      ws.close();

      await delay(6_000);

      const historyCmd = new Deno.Command(Deno.execPath(), {
        args: [
          ...CLI_LAUNCH_ARGS,
          "workflow",
          "history",
          "slow-run",
          "--json",
        ],
        cwd: repoDir,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });
      const historyResult = await historyCmd.output();
      const historyOutput = new TextDecoder().decode(historyResult.stdout);

      assertEquals(
        historyOutput.includes('"succeeded"') ||
          historyOutput.includes('"completed"'),
        true,
        `Expected completed/succeeded run, got: ${historyOutput.slice(0, 500)}`,
      );
    } finally {
      await stopServe(serve);
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "detached run: re-attach via run.attach gets remaining events",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-detached-reattach-",
    });
    const serve = await startServe(repoDir);
    try {
      const ws1 = await connectWs(serve.port);
      sendMsg(ws1, {
        type: "workflow.run",
        id: "r1",
        payload: { workflowIdOrName: "slow-run" },
      });

      const ws1Msgs = await collectUntil(
        ws1,
        (m) => m.type === "event" && m.event?.kind === "started",
        10_000,
      );

      const startedEvent = ws1Msgs.find((m) => m.event?.kind === "started");
      assertExists(startedEvent, "missing started event");
      const runId = startedEvent.event!.runId as string;
      assertExists(runId, "started event missing runId");
      const lastSeq = startedEvent.event!.seq as number;

      ws1.close();
      await delay(500);

      const ws2 = await connectWs(serve.port);
      try {
        sendMsg(ws2, {
          type: "run.attach",
          id: "a1",
          payload: { runId, afterSeq: lastSeq },
        });

        const ws2Msgs = await collectUntil(
          ws2,
          (m) =>
            (m.type === "done" && m.id === "a1") ||
            (m.type === "error" && m.id === "a1"),
          15_000,
        );

        const attached = ws2Msgs.find((m) => m.type === "run.attached");
        assertExists(attached, "missing run.attached response");
        assertEquals(attached.payload?.runId, runId);

        const ws2Events = ws2Msgs.filter((m) => m.type === "event");
        for (const msg of ws2Events) {
          assertEquals(
            (msg.event!.seq as number) > lastSeq,
            true,
            `replay event seq ${msg.event!.seq} should be > ${lastSeq}`,
          );
        }

        const hasDone = ws2Msgs.some(
          (m) => m.type === "done" && m.id === "a1",
        );
        assertEquals(hasDone, true, "missing done frame on re-attach");
      } finally {
        ws2.close();
      }
    } finally {
      await stopServe(serve);
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "detached run: attach to unknown run returns not_found",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-detached-notfound-",
    });
    const serve = await startServe(repoDir);
    try {
      const ws = await connectWs(serve.port);
      try {
        sendMsg(ws, {
          type: "run.attach",
          id: "a1",
          payload: { runId: "nonexistent-run-id" },
        });

        const msgs = await collectUntil(
          ws,
          (m) => m.type === "error" && m.id === "a1",
          5_000,
        );

        const errMsg = msgs.find(
          (m) => m.type === "error" && m.id === "a1",
        );
        assertExists(errMsg, "missing error response");
        assertEquals(errMsg.error?.code, "not_found");
      } finally {
        ws.close();
      }
    } finally {
      await stopServe(serve);
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "detached run: explicit cancel stops a detached run",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-detached-cancel-",
    });
    const serve = await startServe(repoDir);
    try {
      const ws1 = await connectWs(serve.port);
      sendMsg(ws1, {
        type: "workflow.run",
        id: "r1",
        payload: { workflowIdOrName: "slow-run" },
      });

      const ws1Msgs = await collectUntil(
        ws1,
        (m) => m.type === "event" && m.event?.kind === "started",
        10_000,
      );

      const startedEvent = ws1Msgs.find((m) => m.event?.kind === "started");
      const runId = startedEvent!.event!.runId as string;

      ws1.close();
      await delay(500);

      const ws2 = await connectWs(serve.port);
      try {
        sendMsg(ws2, { type: "cancel", id: runId });
        await delay(2_000);

        const historyCmd = new Deno.Command(Deno.execPath(), {
          args: [
            ...CLI_LAUNCH_ARGS,
            "workflow",
            "history",
            "slow-run",
            "--json",
          ],
          cwd: repoDir,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        });
        const historyResult = await historyCmd.output();
        const historyOutput = new TextDecoder().decode(historyResult.stdout);

        assertEquals(
          historyOutput.includes('"cancelled"') ||
            historyOutput.includes('"failed"'),
          true,
          `Expected cancelled/failed run, got: ${historyOutput.slice(0, 500)}`,
        );
      } finally {
        ws2.close();
      }
    } finally {
      await stopServe(serve);
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "detached run: multiple subscribers see the same events",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-detached-multisub-",
    });
    const serve = await startServe(repoDir);
    try {
      const ws1 = await connectWs(serve.port);
      sendMsg(ws1, {
        type: "workflow.run",
        id: "r1",
        payload: { workflowIdOrName: "slow-run" },
      });

      const ws1InitMsgs = await collectUntil(
        ws1,
        (m) => m.type === "event" && m.event?.kind === "started",
        10_000,
      );
      const startedEvent = ws1InitMsgs.find(
        (m) => m.event?.kind === "started",
      );
      const runId = startedEvent!.event!.runId as string;

      const ws2 = await connectWs(serve.port);
      sendMsg(ws2, {
        type: "run.attach",
        id: "a1",
        payload: { runId },
      });

      const [ws1Remaining, ws2All] = await Promise.all([
        collectUntil(
          ws1,
          (m) => m.type === "done" && m.id === "r1",
          15_000,
        ),
        collectUntil(
          ws2,
          (m) => m.type === "done" && m.id === "a1",
          15_000,
        ),
      ]);

      const ws1HasCompleted = ws1InitMsgs.concat(ws1Remaining).some(
        (m) => m.event?.kind === "completed",
      );
      const ws2HasCompleted = ws2All.some(
        (m) => m.event?.kind === "completed",
      );

      assertEquals(ws1HasCompleted, true, "ws1 missing completed event");
      assertEquals(ws2HasCompleted, true, "ws2 missing completed event");

      ws1.close();
      ws2.close();
    } finally {
      await stopServe(serve);
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "detached run: graceful shutdown drains active runs",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-detached-drain-",
    });
    const serve = await startServe(repoDir);
    try {
      const ws = await connectWs(serve.port);
      sendMsg(ws, {
        type: "workflow.run",
        id: "r1",
        payload: { workflowIdOrName: "slow-run" },
      });

      await collectUntil(
        ws,
        (m) => m.type === "event" && m.event?.kind === "started",
        10_000,
      );

      ws.close();

      serve.child.kill("SIGINT");

      const exitResult = await Promise.race([
        serve.child.status,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("serve did not exit within 40s")),
            40_000,
          )
        ),
      ]);

      assertEquals(
        exitResult.code === 0 || exitResult.code === 130,
        true,
        `expected exit code 0 or 130, got ${exitResult.code}`,
      );
    } finally {
      try {
        serve.child.kill("SIGKILL");
      } catch {
        // Already dead
      }
      try {
        await serve.child.status;
      } catch {
        // Already consumed
      }
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});

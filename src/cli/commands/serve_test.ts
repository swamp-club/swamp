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
import {
  assertOffLoopbackSecurity,
  collectServeExtraArgs,
  reapOrphanedWorkflowRuns,
  validateWebSocketOrigin,
} from "./serve.ts";
import { UserError } from "../../domain/errors.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";

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

// --- WebSocket origin/host validation ---

Deno.test("validateWebSocketOrigin: rejects cross-origin http://evil.com", () => {
  const result = validateWebSocketOrigin(
    "http://evil.com",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted origin");
});

Deno.test("validateWebSocketOrigin: rejects attacker-controlled origin", () => {
  const result = validateWebSocketOrigin(
    "http://attacker.example.com",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted origin");
});

Deno.test("validateWebSocketOrigin: accepts http://127.0.0.1", () => {
  const result = validateWebSocketOrigin(
    "http://127.0.0.1",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts http://127.0.0.1 with port", () => {
  const result = validateWebSocketOrigin(
    "http://127.0.0.1:9090",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts http://localhost", () => {
  const result = validateWebSocketOrigin(
    "http://localhost",
    "localhost:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts absent origin (non-browser client)", () => {
  const result = validateWebSocketOrigin(
    null,
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts proxy host on loopback bind", () => {
  const result = validateWebSocketOrigin(
    null,
    "demo.swamp-club.ai",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: rejects untrusted host on off-loopback bind", () => {
  const result = validateWebSocketOrigin(
    null,
    "evil.com:9090",
    "0.0.0.0",
    true,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted host");
});

Deno.test("validateWebSocketOrigin: accepts host 127.0.0.1", () => {
  const result = validateWebSocketOrigin(
    null,
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts host localhost", () => {
  const result = validateWebSocketOrigin(
    null,
    "localhost:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts host matching --host flag", () => {
  const result = validateWebSocketOrigin(
    null,
    "myhost.local:9090",
    "myhost.local",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: TLS adds server domain to trusted origins", () => {
  const result = validateWebSocketOrigin(
    "https://myserver.example.com",
    "myserver.example.com:443",
    "myserver.example.com",
    true,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: TLS server domain rejected without TLS", () => {
  const result = validateWebSocketOrigin(
    "https://myserver.example.com",
    "myserver.example.com:443",
    "myserver.example.com",
    false,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted origin");
});

Deno.test("validateWebSocketOrigin: absent host header passes", () => {
  const result = validateWebSocketOrigin(null, null, "127.0.0.1", false);
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts IPv6 loopback host [::1]:9090", () => {
  const result = validateWebSocketOrigin(
    null,
    "[::1]:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: rejects malformed origin", () => {
  const result = validateWebSocketOrigin(
    "not-a-url",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "malformed origin");
});

// --- Trusted hosts ---

Deno.test("validateWebSocketOrigin: accepts trusted host on off-loopback bind", () => {
  const result = validateWebSocketOrigin(
    null,
    "host.docker.internal:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal"],
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: rejects untrusted host even with other trusted hosts", () => {
  const result = validateWebSocketOrigin(
    null,
    "evil.com:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal"],
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted host");
});

Deno.test("validateWebSocketOrigin: trusted hosts are case-insensitive", () => {
  const result = validateWebSocketOrigin(
    null,
    "Host.Docker.Internal:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal"],
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: multiple trusted hosts", () => {
  const result1 = validateWebSocketOrigin(
    null,
    "host.docker.internal:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal", "host.minikube.internal"],
  );
  assertEquals(result1.allowed, true);

  const result2 = validateWebSocketOrigin(
    null,
    "host.minikube.internal:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal", "host.minikube.internal"],
  );
  assertEquals(result2.allowed, true);
});

Deno.test("validateWebSocketOrigin: trusted hosts do not affect origin validation", () => {
  const result = validateWebSocketOrigin(
    "http://host.docker.internal",
    "host.docker.internal:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal"],
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted origin");
});

Deno.test("validateWebSocketOrigin: empty trusted hosts array has no effect", () => {
  const result = validateWebSocketOrigin(
    null,
    "evil.com:9090",
    "0.0.0.0",
    true,
    [],
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted host");
});

// --- collectServeExtraArgs ---

Deno.test("collectServeExtraArgs: forwards --trusted-hosts", () => {
  const args = collectServeExtraArgs({
    trustedHosts: "host.docker.internal,host.minikube.internal",
  });
  assertEquals(args, [
    "--trusted-hosts",
    "host.docker.internal,host.minikube.internal",
  ]);
});

Deno.test("collectServeExtraArgs: omits --trusted-hosts when not set", () => {
  const args = collectServeExtraArgs({});
  assertEquals(args, []);
});

// --- reapOrphanedWorkflowRuns ---

const WORKFLOW_ID = "96968218-50aa-4b91-8161-a6995ce96cae" as WorkflowId;

type RunStatus =
  | "pending"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";

function makeRun(
  overrides: {
    status?: RunStatus;
    pid?: number;
    id?: string;
  } = {},
): WorkflowRun {
  return WorkflowRun.fromData({
    id: overrides.id ?? crypto.randomUUID(),
    workflowId: WORKFLOW_ID,
    workflowName: "test-workflow",
    status: overrides.status ?? "running",
    startedAt: "2026-07-20T20:00:00.000Z",
    pid: overrides.pid,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt: "2026-07-20T20:00:00.000Z",
      steps: [{
        stepName: "step1",
        status: "running",
        startedAt: "2026-07-20T20:00:00.000Z",
      }],
    }],
    tags: {},
  });
}

// Helper: no tracker record for any run (legacy fallback path)
const noTracker = () => null;

// Helper: tracker says run is still running
const trackerRunning = () => ({ status: "running" });

// Helper: tracker says run was reaped (stale)
const trackerReaped = () => ({ status: "failed" });

Deno.test("reapOrphanedWorkflowRuns: skips run when tracker reports still running", async () => {
  const run = makeRun({ pid: 42 });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    trackerRunning,
  );
  assertEquals(result.reaped, 0);
  assertEquals(result.skipped, 1);
  assertEquals(run.status, "running");
  assertEquals(saved.length, 0);
});

Deno.test("reapOrphanedWorkflowRuns: cancels run when tracker confirmed stale", async () => {
  const run = makeRun({ pid: 99999 });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    trackerReaped,
  );
  assertEquals(result.reaped, 1);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "cancelled");
  assertEquals(saved.length, 1);
});

Deno.test("reapOrphanedWorkflowRuns: legacy run with live PID is skipped", async () => {
  const run = makeRun({ pid: 42 });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    (_pid) => false, // PID is alive
  );
  assertEquals(result.reaped, 0);
  assertEquals(result.skipped, 1);
  assertEquals(run.status, "running");
  assertEquals(saved.length, 0);
});

Deno.test("reapOrphanedWorkflowRuns: legacy run with dead PID is cancelled", async () => {
  const run = makeRun({ pid: 99999 });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    (_pid) => true, // PID is dead
  );
  assertEquals(result.reaped, 1);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "cancelled");
  assertEquals(saved.length, 1);
});

Deno.test("reapOrphanedWorkflowRuns: legacy run with no PID is cancelled", async () => {
  const run = makeRun(); // no pid
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    () => {
      throw new Error("should not be called for undefined pid");
    },
  );
  assertEquals(result.reaped, 1);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "cancelled");
});

Deno.test("reapOrphanedWorkflowRuns: skips run in terminal state", async () => {
  const run = makeRun({ status: "succeeded" });
  const saved: string[] = [];
  const result = await reapOrphanedWorkflowRuns(
    [{ run, workflowId: WORKFLOW_ID }],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    noTracker,
    () => true,
  );
  assertEquals(result.reaped, 0);
  assertEquals(result.skipped, 0);
  assertEquals(run.status, "succeeded");
  assertEquals(saved.length, 0);
});

Deno.test("reapOrphanedWorkflowRuns: mixed scenario with tracker and legacy runs", async () => {
  const trackedLive = makeRun({ pid: 100 });
  const trackedStale = makeRun({ pid: 200 });
  const legacyDeadPid = makeRun({ pid: 300 });
  const legacyNoPid = makeRun();
  const succeededRun = makeRun({ status: "succeeded" });
  const saved: string[] = [];

  const trackerMap = new Map<string, { status: string }>([
    [trackedLive.id, { status: "running" }],
    [trackedStale.id, { status: "failed" }],
  ]);

  const result = await reapOrphanedWorkflowRuns(
    [
      { run: trackedLive, workflowId: WORKFLOW_ID },
      { run: trackedStale, workflowId: WORKFLOW_ID },
      { run: legacyDeadPid, workflowId: WORKFLOW_ID },
      { run: legacyNoPid, workflowId: WORKFLOW_ID },
      { run: succeededRun, workflowId: WORKFLOW_ID },
    ],
    (_wid, r) => {
      saved.push(r.id);
      return Promise.resolve();
    },
    (runId) => trackerMap.get(runId) ?? null,
    (pid) => pid === 300, // only PID 300 is dead
  );
  assertEquals(result.reaped, 3); // tracker-stale + legacy dead PID + legacy no PID
  assertEquals(result.skipped, 1); // tracker-live
  assertEquals(trackedLive.status, "running");
  assertEquals(trackedStale.status, "cancelled");
  assertEquals(legacyDeadPid.status, "cancelled");
  assertEquals(legacyNoPid.status, "cancelled");
  assertEquals(succeededRun.status, "succeeded");
  assertEquals(saved.length, 3);
});

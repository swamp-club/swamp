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

import { assertEquals, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import {
  WorkflowRun,
  type WorkflowRunInput,
} from "../../domain/workflows/workflow_run.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import {
  buildCancelUrl,
  cancelAllLocalRuns,
  cancelLocalRun,
  isServeOwnedRun,
  SERVER_CANCEL_TIMEOUT_MS,
  serverCancelFailure,
  serverCancelRejection,
} from "./workflow_cancel.ts";
import { RUN_CANCEL_GRACE_MS } from "../../serve/suspended_run_cancel.ts";
import { GATE_WAIT_TIMEOUT_MS } from "../../serve/sync_gate.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

const WORKFLOW_ID = "a0000000-0000-4000-8000-000000000001";

function makeRun(
  overrides: {
    status?:
      | "pending"
      | "running"
      | "suspended"
      | "succeeded"
      | "failed"
      | "cancelled";
    pid?: number;
    instanceId?: string;
  } = {},
): WorkflowRun {
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: WORKFLOW_ID,
    workflowName: "test-workflow",
    status: overrides.status ?? "running",
    startedAt: "2026-07-20T20:00:00.000Z",
    pid: overrides.pid,
    instanceId: overrides.instanceId,
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

Deno.test("isServeOwnedRun: returns true when instanceId is set", () => {
  const run = makeRun({ instanceId: crypto.randomUUID() });
  assertEquals(isServeOwnedRun(run), true);
});

Deno.test("isServeOwnedRun: returns false when instanceId is undefined", () => {
  const run = makeRun();
  assertEquals(isServeOwnedRun(run), false);
});

Deno.test("isServeOwnedRun: returns false for CLI-started run with pid", () => {
  const run = makeRun({ pid: 12345 });
  assertEquals(isServeOwnedRun(run), false);
});

Deno.test("isServeOwnedRun: returns true for serve run with both pid and instanceId", () => {
  const run = makeRun({ pid: 12345, instanceId: crypto.randomUUID() });
  assertEquals(isServeOwnedRun(run), true);
});

Deno.test("buildCancelUrl: maps ws(s) to http(s) and appends the cancel path", () => {
  assertEquals(
    buildCancelUrl("ws://127.0.0.1:9000", "run-1"),
    "http://127.0.0.1:9000/api/v1/cancel/workflow-run/run-1",
  );
  assertEquals(
    buildCancelUrl("wss://serve.example.com/swamp/", "a/b"),
    "https://serve.example.com/swamp/api/v1/cancel/workflow-run/a%2Fb",
  );
});

Deno.test("buildCancelUrl: drops userinfo, token query and fragment", () => {
  assertEquals(
    buildCancelUrl(
      "http://alice:hunter2@127.0.0.1:9000/?token=abc.s3cret#frag",
      "run-1",
    ),
    "http://127.0.0.1:9000/api/v1/cancel/workflow-run/run-1",
  );
});

Deno.test("buildCancelUrl: the invalid-URL error hides credentials", () => {
  const error = assertThrows(
    () => buildCancelUrl("ftp://alice:hunter2@h:2121/?token=abc.s3cret", "r"),
    UserError,
  );
  for (const secret of ["alice", "hunter2", "s3cret"]) {
    assertEquals(error.message.includes(secret), false, secret);
  }
});

Deno.test("workflowCancelCommand module loads", async () => {
  const { workflowCancelCommand } = await import("./workflow_cancel.ts");
  assertEquals(workflowCancelCommand.getName(), "cancel");
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-workflow-cancel-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

// A PID that is not this process, so cancelLocalRun asks to kill it.
const OWNER_PID = Deno.pid + 1;

/**
 * The run as `workflow cancel` loads it: saved at run start, before the
 * forEach step `build` expanded.
 */
function snapshotData(
  runId: string,
  pid: number | null = OWNER_PID,
): WorkflowRunInput {
  return {
    id: runId,
    workflowId: WORKFLOW_ID,
    workflowName: "test-workflow",
    status: "running",
    startedAt: "2026-07-20T20:00:00.000Z",
    pid: pid ?? undefined,
    jobs: [{
      jobName: "main",
      status: "pending",
      steps: [
        { stepName: "build", status: "pending" },
        { stepName: "rollback", status: "pending" },
      ],
    }],
    tags: {},
  };
}

/** The run as its owning process saves it while handling SIGTERM. */
function ownerFinalData(
  runId: string,
  status: "running" | "cancelled" | "failed" | "succeeded",
): WorkflowRunInput {
  const terminal = status !== "running";
  return {
    ...snapshotData(runId),
    status,
    completedAt: terminal ? "2026-07-20T20:00:03.000Z" : undefined,
    jobs: [{
      jobName: "main",
      status: terminal ? "failed" : "running",
      startedAt: "2026-07-20T20:00:00.000Z",
      steps: [
        {
          stepName: "build-1",
          status: terminal ? "failed" : "running",
          startedAt: "2026-07-20T20:00:00.000Z",
          error: terminal ? "cancelled" : undefined,
          forEachTemplate: "build",
        },
        {
          stepName: "rollback",
          status: terminal ? "skipped" : "pending",
          skipReason: terminal ? { kind: "dependency" } : undefined,
        },
      ],
    }],
    tags: status === "cancelled"
      ? { cancel_reason: "The signal has been aborted" }
      : {},
  };
}

function stepSummary(run: WorkflowRun): string[] {
  return run.jobs[0].steps.map((s) => `${s.stepName}:${s.status}`);
}

Deno.test("cancelLocalRun: keeps the record the owner cancelled and records the reason", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runId = crypto.randomUUID();
    const snapshot = WorkflowRun.fromData(snapshotData(runId));
    await runRepo.save(workflowId, snapshot);

    const killed: number[] = [];
    const result = await cancelLocalRun(
      snapshot,
      workflowId,
      "No longer needed",
      {
        runRepo,
        killProcess: async (pid) => {
          killed.push(pid);
          await runRepo.save(
            workflowId,
            WorkflowRun.fromData(ownerFinalData(runId, "cancelled")),
          );
          return true;
        },
      },
    );

    assertEquals(killed, [OWNER_PID]);
    const stored = await runRepo.findById(workflowId, snapshot.id);
    for (const run of [result, stored]) {
      assertEquals(run?.status, "cancelled");
      assertEquals(run?.tags.cancel_reason, "No longer needed");
      assertEquals(run?.jobs[0].status, "failed");
      assertEquals(stepSummary(run!), ["build-1:failed", "rollback:skipped"]);
      assertEquals(run?.jobs[0].steps[0].error, "cancelled");
      assertEquals(run?.jobs[0].steps[1].skipReason, { kind: "dependency" });
    }
  });
});

Deno.test("cancelLocalRun: leaves a record the owner finished as failed or succeeded untouched", async () => {
  for (const status of ["failed", "succeeded"] as const) {
    await withTempDir(async (dir) => {
      const runRepo = new YamlWorkflowRunRepository(dir);
      const workflowId = createWorkflowId(WORKFLOW_ID);
      const runId = crypto.randomUUID();
      const snapshot = WorkflowRun.fromData(snapshotData(runId));
      await runRepo.save(workflowId, snapshot);
      const ownerFinal = WorkflowRun.fromData(ownerFinalData(runId, status));

      const result = await cancelLocalRun(
        snapshot,
        workflowId,
        "No longer needed",
        {
          runRepo,
          killProcess: async () => {
            await runRepo.save(workflowId, ownerFinal);
            return true;
          },
        },
      );

      assertEquals(result?.status, status);
      const stored = await runRepo.findById(workflowId, snapshot.id);
      assertEquals(stored?.toData(), ownerFinal.toData());
    });
  }
});

Deno.test("cancelLocalRun: cancels the owner's last saved record when it never finished", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runId = crypto.randomUUID();
    const snapshot = WorkflowRun.fromData(snapshotData(runId));
    await runRepo.save(workflowId, snapshot);

    // The owner saved progress, then was SIGKILLed before its final save.
    const result = await cancelLocalRun(
      snapshot,
      workflowId,
      "No longer needed",
      {
        runRepo,
        killProcess: async () => {
          await runRepo.save(
            workflowId,
            WorkflowRun.fromData(ownerFinalData(runId, "running")),
          );
          return true;
        },
      },
    );

    const stored = await runRepo.findById(workflowId, snapshot.id);
    for (const run of [result, stored]) {
      assertEquals(run?.status, "cancelled");
      assertEquals(run?.tags.cancel_reason, "No longer needed");
      assertEquals(stepSummary(run!), ["build-1:running", "rollback:pending"]);
    }
  });
});

Deno.test("cancelLocalRun: cancels without a kill when no other process owns the run", async () => {
  for (const pid of [null, Deno.pid]) {
    await withTempDir(async (dir) => {
      const runRepo = new YamlWorkflowRunRepository(dir);
      const workflowId = createWorkflowId(WORKFLOW_ID);
      const snapshot = WorkflowRun.fromData(
        snapshotData(crypto.randomUUID(), pid),
      );
      await runRepo.save(workflowId, snapshot);

      let killCalls = 0;
      const result = await cancelLocalRun(
        snapshot,
        workflowId,
        "No longer needed",
        {
          runRepo,
          killProcess: () => {
            killCalls++;
            return Promise.resolve(true);
          },
        },
      );

      assertEquals(killCalls, 0);
      assertEquals(result?.status, "cancelled");
      const stored = await runRepo.findById(workflowId, snapshot.id);
      assertEquals(stored?.status, "cancelled");
      assertEquals(stored?.tags.cancel_reason, "No longer needed");
    });
  }
});

Deno.test("cancelLocalRun: does not recreate a run record deleted during the kill", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const snapshot = WorkflowRun.fromData(snapshotData(crypto.randomUUID()));

    const result = await cancelLocalRun(
      snapshot,
      workflowId,
      "No longer needed",
      { runRepo, killProcess: () => Promise.resolve(true) },
    );

    assertEquals(result, null);
    assertEquals(await runRepo.findById(workflowId, snapshot.id), null);
  });
});

Deno.test("cancelAllLocalRuns: counts only runs that ended cancelled", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const cancelledId = crypto.randomUUID();
    const succeededId = crypto.randomUUID();
    const deletedId = crypto.randomUUID();
    const snapshots = [cancelledId, succeededId, deletedId].map((id) =>
      WorkflowRun.fromData(snapshotData(id))
    );
    await runRepo.save(workflowId, snapshots[0]);
    await runRepo.save(workflowId, snapshots[1]);

    // Only the succeeded run's owner saves a final record during the kill;
    // the deleted run was never saved.
    const result = await cancelAllLocalRuns(
      snapshots.map((run) => ({
        run,
        workflowId,
        workflowName: "test-workflow",
      })),
      "No longer needed",
      {
        runRepo,
        killProcess: async () => {
          await runRepo.save(
            workflowId,
            WorkflowRun.fromData(ownerFinalData(succeededId, "succeeded")),
          );
          return true;
        },
      },
    );

    assertEquals(result, {
      cancelled: [{
        runId: cancelledId,
        workflowName: "test-workflow",
        previousStatus: "running",
      }],
      finished: [{
        runId: succeededId,
        workflowName: "test-workflow",
        previousStatus: "running",
        status: "succeeded",
      }],
      deleted: [{
        runId: deletedId,
        workflowName: "test-workflow",
      }],
    });
  });
});

Deno.test("SERVER_CANCEL_TIMEOUT_MS: outlasts the server's grace period and sync gate wait", () => {
  assertEquals(
    SERVER_CANCEL_TIMEOUT_MS > RUN_CANCEL_GRACE_MS + GATE_WAIT_TIMEOUT_MS,
    true,
  );
});

Deno.test("serverCancelFailure: a timeout says the cancel may still complete", () => {
  const error = serverCancelFailure(
    "ws://alice:hunter2@127.0.0.1:9000/?token=abc.s3cret",
    "run-1",
    new DOMException("timed out", "TimeoutError"),
  );

  assertEquals(error instanceof UserError, true);
  assertEquals(
    error.message.startsWith(
      `No answer from ws://127.0.0.1:9000 within ${
        SERVER_CANCEL_TIMEOUT_MS / 1000
      }s. The cancel may still complete on the server`,
    ),
    true,
    error.message,
  );
  assertEquals(
    error.message.includes("swamp workflow history get run-1 --server"),
    true,
  );
  assertEquals(error.message.includes("hunter2"), false);
  assertEquals(error.message.includes("s3cret"), false);
});

Deno.test("serverCancelFailure: other failures are reported as a connection error", () => {
  const error = serverCancelFailure(
    "ws://127.0.0.1:9000",
    "run-1",
    new TypeError("connection refused"),
  );

  assertEquals(error.message.startsWith("Could not connect to "), true);
  assertEquals(error.message.endsWith(": connection refused"), true);
});

Deno.test("serverCancelRejection: shows the message of a JSON refusal on its own", () => {
  const notFound = serverCancelRejection(
    404,
    "Not Found",
    JSON.stringify({
      status: "not_found",
      message: "No cancellable workflow-run with id r1",
    }),
  );
  assertEquals(notFound instanceof UserError, true);
  assertEquals(notFound.message, "No cancellable workflow-run with id r1");

  const conflict = serverCancelRejection(
    409,
    "Conflict",
    JSON.stringify({
      status: "conflict",
      message: "Another operation on this run is in progress; try again",
    }),
  );
  assertEquals(
    conflict.message,
    "Another operation on this run is in progress; try again",
  );
});

Deno.test("serverCancelRejection: keeps the status for a plain-text refusal", () => {
  assertEquals(
    serverCancelRejection(401, "Unauthorized", "Unauthorized: token required")
      .message,
    "Server returned 401: Unauthorized: token required",
  );
  assertEquals(
    serverCancelRejection(429, "Too Many Requests", "Too Many Requests")
      .message,
    "Server returned 429: Too Many Requests",
  );
});

Deno.test("serverCancelRejection: falls back to the raw body when JSON has no message", () => {
  assertEquals(
    serverCancelRejection(500, "Internal Server Error", '{"status":"error"}')
      .message,
    'Server returned 500: {"status":"error"}',
  );
  assertEquals(
    serverCancelRejection(500, "Internal Server Error", "[]").message,
    "Server returned 500: []",
  );
});

Deno.test("serverCancelRejection: uses the status text for an empty body", () => {
  assertEquals(
    serverCancelRejection(502, "Bad Gateway", "").message,
    "Server returned 502: Bad Gateway",
  );
});

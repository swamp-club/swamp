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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import {
  OWNER_STOPPED_STEP_ERROR,
  WorkflowRun,
  type WorkflowRunInput,
} from "../../domain/workflows/workflow_run.ts";
import { CLEANUP_GRACE_TIMEOUT_MS } from "../../domain/workflows/execution_service.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { TriggerCondition } from "../../domain/workflows/trigger_condition.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import {
  buildCancelUrl,
  cancelAllLocalRuns,
  cancelLocalRun,
  type CancelTargetDeps,
  findAllActiveRuns,
  isServeOwnedRun,
  OWNER_STOP_GRACE_MS,
  resolveLocalCancelTarget,
  RunNotCancelledError,
  SERVER_CANCEL_TIMEOUT_MS,
  serverCancelFailure,
  serverCancelRejection,
} from "./workflow_cancel.ts";
import { RUN_CANCEL_GRACE_MS } from "../../serve/suspended_run_cancel.ts";
import { DatabaseSync } from "node:sqlite";
import { hostname } from "node:os";
import { dirname, join } from "@std/path";
import { ActiveRun } from "../../domain/models/active_run.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import type { MethodRunOutputs } from "../../domain/workflows/orphaned_run_reaper.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { GATE_WAIT_TIMEOUT_MS } from "../../serve/sync_gate.ts";
import type { BrokenWorkflow } from "../../libswamp/workflows/broken_workflow.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";
import {
  unclaimedRuns,
  type WorkflowRunClaims,
} from "../../domain/workflows/run_claim.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";

await initializeLogging({});

const WORKFLOW_ID = "a0000000-0000-4000-8000-000000000001";

/** The workflow the runs here belong to; it defines none of their jobs. */
const WORKFLOW = Workflow.create({ id: WORKFLOW_ID, name: "test-workflow" });

/** Runs here have no evaluated snapshot. */
const noSnapshot = () => Promise.resolve(null);

/** Cancel deps for runs with no tracker rows or method-run records. */
const untracked = {
  runTracker: {
    findAllRunning: () => [],
  } as unknown as RunTrackerRepository,
  outputRepo: {
    findByIds: () => Promise.resolve(new Map()),
    save: () => Promise.reject(new Error("unexpected output save")),
  } as MethodRunOutputs,
};

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
      WORKFLOW,
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
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
        WORKFLOW,
        "No longer needed",
        {
          runRepo,
          findEvaluatedWorkflow: noSnapshot,
          runClaims: unclaimedRuns,
          ...untracked,
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

Deno.test("cancelLocalRun: fails the work a stopped owner left running and cancels the run", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runId = crypto.randomUUID();
    const snapshot = WorkflowRun.fromData(snapshotData(runId));
    await runRepo.save(workflowId, snapshot);

    // The owner saved progress, then was SIGKILLed before its final save.
    const result = await cancelLocalRun(
      snapshot,
      WORKFLOW,
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
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
      // The workflow defines no job here, so the job is settled from its
      // records alone: the step the owner left running fails as cut off,
      // and the step it never reached is cancelled.
      assertEquals(run?.jobs[0].status, "failed");
      assertEquals(stepSummary(run!), ["build-1:failed", "rollback:failed"]);
      assertEquals(run?.jobs[0].steps[0].error, OWNER_STOPPED_STEP_ERROR);
      assertEquals(run?.jobs[0].steps[1].error, "cancelled");
    }
  });
});

Deno.test("cancelLocalRun: settles a dead owner's run against the workflow's steps", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runId = crypto.randomUUID();
    const snapshot = WorkflowRun.fromData(snapshotData(runId));
    await runRepo.save(workflowId, snapshot);
    // build is a forEach step whose iteration build-1 was running when the
    // owner died; rollback needs build to succeed.
    const workflow = Workflow.create({
      id: WORKFLOW_ID,
      name: "test-workflow",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "build",
            task: StepTask.model("m", "run"),
            forEach: { item: "n", in: "${{ [1] }}" },
          }),
          Step.create({
            name: "rollback",
            task: StepTask.model("m", "run"),
            dependsOn: [{
              step: "build",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      })],
    });

    const result = await cancelLocalRun(
      snapshot,
      workflow,
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
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
      assertEquals(run?.jobs[0].status, "failed");
      assertEquals(stepSummary(run!), ["build-1:failed", "rollback:skipped"]);
      assertEquals(run?.jobs[0].steps[1].skipReason, { kind: "dependency" });
      assertEquals(run?.jobs[0].steps[1].settledByAbort, true);
    }
  });
});

Deno.test("OWNER_STOP_GRACE_MS: outlasts the cleanup grace a cancelled run gets", () => {
  assertEquals(OWNER_STOP_GRACE_MS > CLEANUP_GRACE_TIMEOUT_MS, true);
});

Deno.test("cancelLocalRun: gives the owner the cleanup grace before it is killed", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const snapshot = WorkflowRun.fromData(snapshotData(crypto.randomUUID()));
    await runRepo.save(workflowId, snapshot);

    const waits: number[] = [];
    await cancelLocalRun(snapshot, WORKFLOW, "No longer needed", {
      runRepo,
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
      ...untracked,
      killProcess: (_pid, { maxWaitMs }) => {
        waits.push(maxWaitMs);
        return Promise.resolve(true);
      },
    });

    assertEquals(waits, [OWNER_STOP_GRACE_MS]);
  });
});

Deno.test("cancelLocalRun: stops the owner first, then settles the stored record under the run's claim", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const snapshot = WorkflowRun.fromData(snapshotData(crypto.randomUUID()));
    await runRepo.save(workflowId, snapshot);

    const order: string[] = [];
    let statusWhenClaimed: string | undefined;
    await cancelLocalRun(snapshot, WORKFLOW, "No longer needed", {
      runRepo,
      findEvaluatedWorkflow: noSnapshot,
      runClaims: {
        withClaim: async (runId, fn) => {
          order.push(`claim:${runId}`);
          statusWhenClaimed = (await runRepo.findById(workflowId, snapshot.id))
            ?.status;
          const result = await fn();
          order.push("release");
          return result;
        },
      },
      ...untracked,
      killProcess: () => {
        order.push("kill");
        return Promise.resolve(true);
      },
    });

    // The owner's grace is not spent holding the claim, and nothing is
    // saved before the claim is taken.
    assertEquals(order, ["kill", `claim:${snapshot.id}`, "release"]);
    assertEquals(statusWhenClaimed, "running");
    assertEquals(
      (await runRepo.findById(workflowId, snapshot.id))?.status,
      "cancelled",
    );
  });
});

/** The run suspended at a gate, with no live owner, as cancel first reads it. */
function suspendedData(runId: string): WorkflowRunInput {
  return { ...snapshotData(runId, null), status: "suspended" };
}

Deno.test("cancelLocalRun: stops a process that took the run over before the claim, and saves nothing over it first", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runId = crypto.randomUUID();
    const snapshot = WorkflowRun.fromData(suspendedData(runId));
    await runRepo.save(workflowId, snapshot);
    // A `workflow resume` took the run over after cancel read it suspended.
    const RESUMER_PID = Deno.pid + 2;
    await runRepo.save(
      workflowId,
      WorkflowRun.fromData(snapshotData(runId, RESUMER_PID)),
    );

    const killed: number[] = [];
    const statusAtKill: (string | undefined)[] = [];
    const result = await cancelLocalRun(
      snapshot,
      WORKFLOW,
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
        liveness: {
          hostname: hostname(),
          isDead: (pid) => killed.includes(pid),
        },
        killProcess: async (pid) => {
          statusAtKill.push(
            (await runRepo.findById(workflowId, snapshot.id))?.status,
          );
          killed.push(pid);
          return true;
        },
      },
    );

    assertEquals(killed, [RESUMER_PID]);
    // The record still read running when the resumer was stopped.
    assertEquals(statusAtKill, ["running"]);
    assertEquals(result?.status, "cancelled");
    assertEquals(
      (await runRepo.findById(workflowId, snapshot.id))?.status,
      "cancelled",
    );
  });
});

Deno.test("cancelLocalRun: keeps the record a taken-over run's process saved when it was stopped", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runId = crypto.randomUUID();
    const snapshot = WorkflowRun.fromData(suspendedData(runId));
    const RESUMER_PID = Deno.pid + 2;
    await runRepo.save(
      workflowId,
      WorkflowRun.fromData(snapshotData(runId, RESUMER_PID)),
    );

    const killed: number[] = [];
    const result = await cancelLocalRun(
      snapshot,
      WORKFLOW,
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
        liveness: {
          hostname: hostname(),
          isDead: (pid) => killed.includes(pid),
        },
        // The resumer saves its own cancelled record while handling SIGTERM.
        killProcess: async (pid) => {
          await runRepo.save(
            workflowId,
            WorkflowRun.fromData(ownerFinalData(runId, "cancelled")),
          );
          killed.push(pid);
          return true;
        },
      },
    );

    assertEquals(killed, [RESUMER_PID]);
    assertEquals(result?.status, "cancelled");
    assertEquals(result?.tags["cancel_reason"], "No longer needed");
    assertEquals(stepSummary(result!), ["build-1:failed", "rollback:skipped"]);
  });
});

Deno.test("cancelLocalRun: gives up, saving nothing, when the run keeps being taken over", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runId = crypto.randomUUID();
    const snapshot = WorkflowRun.fromData(suspendedData(runId));
    let nextPid = Deno.pid + 2;
    await runRepo.save(
      workflowId,
      WorkflowRun.fromData(snapshotData(runId, nextPid)),
    );

    const killed: number[] = [];
    await assertRejects(
      () =>
        cancelLocalRun(snapshot, WORKFLOW, "No longer needed", {
          runRepo,
          findEvaluatedWorkflow: noSnapshot,
          runClaims: unclaimedRuns,
          ...untracked,
          liveness: {
            hostname: hostname(),
            isDead: (pid) => killed.includes(pid),
          },
          // Each stop is followed by another process taking the run over.
          killProcess: async (pid) => {
            killed.push(pid);
            nextPid++;
            await runRepo.save(
              workflowId,
              WorkflowRun.fromData(snapshotData(runId, nextPid)),
            );
            return true;
          },
        }),
      RunNotCancelledError,
      `is running under another process (pid ${Deno.pid + 5})`,
    );

    assertEquals(killed.length, 3);
    assertEquals(
      (await runRepo.findById(workflowId, snapshot.id))?.status,
      "running",
    );
  });
});

Deno.test("cancelAllLocalRuns: stops a process that took a listed run over before its claim", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runId = crypto.randomUUID();
    const snapshot = WorkflowRun.fromData(suspendedData(runId));
    const RESUMER_PID = Deno.pid + 2;
    await runRepo.save(
      workflowId,
      WorkflowRun.fromData(snapshotData(runId, RESUMER_PID)),
    );

    const killed: number[] = [];
    const result = await cancelAllLocalRuns(
      [{ run: snapshot, workflow: WORKFLOW }],
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
        liveness: {
          hostname: hostname(),
          isDead: (pid) => killed.includes(pid),
        },
        killProcess: (pid) => {
          killed.push(pid);
          return Promise.resolve(true);
        },
      },
    );

    assertEquals(killed, [RESUMER_PID]);
    assertEquals(result.cancelled.map((entry) => entry.runId), [runId]);
  });
});

Deno.test("cancelLocalRun: refuses, without a kill or a save, a run a serve instance took over", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runId = crypto.randomUUID();
    const snapshot = WorkflowRun.fromData(suspendedData(runId));
    // Serve auto-resumed the run: the recorded pid is the server's own.
    const SERVE_PID = Deno.pid + 2;
    await runRepo.save(
      workflowId,
      WorkflowRun.fromData({
        ...snapshotData(runId, SERVE_PID),
        instanceId: "serve-1",
      }),
    );

    const killed: number[] = [];
    const error = await assertRejects(
      () =>
        cancelLocalRun(snapshot, WORKFLOW, "No longer needed", {
          runRepo,
          findEvaluatedWorkflow: noSnapshot,
          runClaims: unclaimedRuns,
          ...untracked,
          liveness: { hostname: hostname(), isDead: () => false },
          killProcess: (pid) => {
            killed.push(pid);
            return Promise.resolve(true);
          },
        }),
      RunNotCancelledError,
      "was taken over by a serve instance and was not cancelled",
    );

    assertEquals(
      error.message.includes(
        `swamp workflow cancel --run ${runId} --server <url>`,
      ),
      true,
    );
    assertEquals(killed, []);
    const stored = await runRepo.findById(workflowId, snapshot.id);
    assertEquals(stored?.status, "running");
    assertEquals(stored?.instanceId, "serve-1");
  });
});

Deno.test("cancelAllLocalRuns: reports a run serve took over as not cancelled and settles the rest", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const takenId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const taken = WorkflowRun.fromData(suspendedData(takenId));
    const other = WorkflowRun.fromData(suspendedData(otherId));
    await runRepo.save(
      workflowId,
      WorkflowRun.fromData({
        ...snapshotData(takenId, Deno.pid + 2),
        instanceId: "serve-1",
      }),
    );
    await runRepo.save(workflowId, other);

    const killed: number[] = [];
    const result = await cancelAllLocalRuns(
      [
        { run: taken, workflow: WORKFLOW },
        { run: other, workflow: WORKFLOW },
      ],
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
        liveness: { hostname: hostname(), isDead: () => false },
        killProcess: (pid) => {
          killed.push(pid);
          return Promise.resolve(true);
        },
      },
    );

    assertEquals(killed, []);
    assertEquals(result.notCancelled.map((entry) => entry.runId), [takenId]);
    assertEquals(result.notCancelled[0].status, "running");
    assertEquals(result.cancelled.map((entry) => entry.runId), [otherId]);
    assertEquals(
      (await runRepo.findById(workflowId, taken.id))?.status,
      "running",
    );
    assertEquals(
      (await runRepo.findById(workflowId, other.id))?.status,
      "cancelled",
    );
  });
});

/** Claims that time out for `stuck` and exclude nobody otherwise. */
function claimsStuckOn(stuck: string): WorkflowRunClaims {
  return {
    withClaim: (runId, fn) =>
      runId === stuck
        ? Promise.reject(
          new LockTimeoutError(`workflow-run-claims/${runId}/.lock`, null, 1),
        )
        : fn(),
  };
}

Deno.test("cancelAllLocalRuns: a claim that times out leaves that run reported and the rest cancelled", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runs = [0, 1, 2].map(() =>
      WorkflowRun.fromData(suspendedData(crypto.randomUUID()))
    );
    for (const run of runs) await runRepo.save(workflowId, run);
    const [first, stuck, last] = runs;

    const result = await cancelAllLocalRuns(
      runs.map((run) => ({ run, workflow: WORKFLOW })),
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: claimsStuckOn(stuck.id),
        ...untracked,
        killProcess: () => Promise.resolve(true),
      },
    );

    // The run after the stuck one is still tried.
    assertEquals(
      result.cancelled.map((entry) => entry.runId),
      [first.id, last.id],
    );
    assertEquals(result.notCancelled.length, 1);
    assertEquals(result.notCancelled[0].runId, stuck.id);
    assertEquals(result.notCancelled[0].status, "suspended");
    assertEquals(result.notCancelled[0].reason.includes("timed out"), true);
    assertEquals(result.claimTimedOut, true);
    assertEquals(
      (await runRepo.findById(workflowId, stuck.id))?.status,
      "suspended",
    );
  });
});

Deno.test("cancelAllLocalRuns: a run its stopped owner cancelled counts as cancelled when its claim times out", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const runId = crypto.randomUUID();
    const snapshot = WorkflowRun.fromData(snapshotData(runId));
    await runRepo.save(workflowId, snapshot);

    const result = await cancelAllLocalRuns(
      [{ run: snapshot, workflow: WORKFLOW }],
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: claimsStuckOn(snapshot.id),
        ...untracked,
        // The owner saves its own cancelled record while handling SIGTERM.
        killProcess: async () => {
          await runRepo.save(
            workflowId,
            WorkflowRun.fromData(ownerFinalData(runId, "cancelled")),
          );
          return true;
        },
      },
    );

    assertEquals(result.cancelled.map((entry) => entry.runId), [runId]);
    assertEquals(result.notCancelled, []);
    assertEquals(result.claimTimedOut, false);
  });
});

Deno.test("cancelAllLocalRuns: an error that is not a refusal or a lock timeout still propagates", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const snapshot = WorkflowRun.fromData(suspendedData(crypto.randomUUID()));
    await runRepo.save(workflowId, snapshot);

    await assertRejects(
      () =>
        cancelAllLocalRuns(
          [{ run: snapshot, workflow: WORKFLOW }],
          "No longer needed",
          {
            runRepo,
            findEvaluatedWorkflow: noSnapshot,
            runClaims: {
              withClaim: () => Promise.reject(new Error("disk full")),
            },
            ...untracked,
            killProcess: () => Promise.resolve(true),
          },
        ),
      Error,
      "disk full",
    );
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
        WORKFLOW,
        "No longer needed",
        {
          runRepo,
          findEvaluatedWorkflow: noSnapshot,
          runClaims: unclaimedRuns,
          ...untracked,
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
      WORKFLOW,
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
        killProcess: () => Promise.resolve(true),
      },
    );

    assertEquals(result, null);
    assertEquals(await runRepo.findById(workflowId, snapshot.id), null);
  });
});

Deno.test("cancelAllLocalRuns: stops a process that owns several runs once", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    // A parent run and the nested run it started share one process.
    const snapshots = [crypto.randomUUID(), crypto.randomUUID()].map((id) =>
      WorkflowRun.fromData(snapshotData(id))
    );
    for (const run of snapshots) await runRepo.save(workflowId, run);

    const killed: number[] = [];
    const result = await cancelAllLocalRuns(
      snapshots.map((run) => ({
        run,
        workflow: WORKFLOW,
      })),
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
        killProcess: (pid) => {
          killed.push(pid);
          return Promise.resolve(true);
        },
      },
    );

    assertEquals(killed, [OWNER_PID]);
    assertEquals(
      result.cancelled.map((c) => c.runId),
      snapshots.map((r) => r.id),
    );
  });
});

Deno.test("cancelAllLocalRuns: stops different owners together", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const snapshots = [OWNER_PID, OWNER_PID + 1].map((pid) =>
      WorkflowRun.fromData(snapshotData(crypto.randomUUID(), pid))
    );
    for (const run of snapshots) await runRepo.save(workflowId, run);

    // Each kill waits until both have started, so stopping the owners one
    // after another would never finish.
    const started: number[] = [];
    let bothStarted: () => void = () => {};
    const allStarted = new Promise<void>((resolve) => bothStarted = resolve);
    const result = await cancelAllLocalRuns(
      snapshots.map((run) => ({
        run,
        workflow: WORKFLOW,
      })),
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
        killProcess: async (pid) => {
          started.push(pid);
          if (started.length === 2) bothStarted();
          await allStarted;
          return true;
        },
      },
    );

    assertEquals(started.toSorted(), [OWNER_PID, OWNER_PID + 1]);
    assertEquals(
      result.cancelled.map((c) => c.runId),
      snapshots.map((r) => r.id),
    );
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
      snapshots.map((run) => ({ run, workflow: WORKFLOW })),
      "No longer needed",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
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
      notCancelled: [],
      claimTimedOut: false,
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

// --- what a stopped owner left open ---

const SHELL = ModelType.create("command/shell");

function ownerRow(
  id: string,
  pid: number,
  runKind: "workflow" | "model_method",
): ActiveRun {
  const now = new Date().toISOString();
  return ActiveRun.fromData({
    id,
    runKind,
    modelType: runKind === "model_method" ? SHELL.normalized : null,
    methodName: runKind === "model_method" ? "execute" : null,
    workflowName: runKind === "workflow" ? "test-workflow" : null,
    pid,
    hostname: hostname(),
    startedAt: now,
    heartbeatAt: now,
    status: "running",
  });
}

/** A step's method-run record, saved `running` by process `pid`. */
async function saveStepOutput(
  outputRepo: YamlOutputRepository,
  pid: number,
): Promise<ModelOutput> {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "execute",
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "workflow",
    },
  });
  output.markRunning(pid);
  await outputRepo.save(SHELL, "execute", output);
  return output;
}

function cancelReasonOf(dbPath: string, id: string): string | null {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("SELECT cancel_reason FROM active_runs WHERE id = ?")
      .get(id) as { cancel_reason: string | null }).cancel_reason;
  } finally {
    db.close();
  }
}

/**
 * A run whose owner OWNER_PID is killed without saving anything, with a
 * step method run in flight and a method run of another process beside it.
 */
async function withKilledOwner(
  fn: (ctx: {
    runRepo: YamlWorkflowRunRepository;
    outputRepo: YamlOutputRepository;
    tracker: RunTrackerStore;
    dbPath: string;
    run: WorkflowRun;
    step: ModelOutput;
    stranger: ModelOutput;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const outputRepo = new YamlOutputRepository(dir);
    const dbPath = join(dir, "run_tracker.db");
    const tracker = new RunTrackerStore(dbPath);
    try {
      const run = WorkflowRun.fromData(snapshotData(crypto.randomUUID()));
      await runRepo.save(createWorkflowId(WORKFLOW_ID), run);
      const step = await saveStepOutput(outputRepo, OWNER_PID);
      const stranger = await saveStepOutput(outputRepo, OWNER_PID + 1);
      tracker.register(ownerRow(run.id, OWNER_PID, "workflow"));
      tracker.register(ownerRow(step.id, OWNER_PID, "model_method"));
      tracker.register(ownerRow(stranger.id, OWNER_PID + 1, "model_method"));
      await fn({ runRepo, outputRepo, tracker, dbPath, run, step, stranger });
    } finally {
      tracker.close();
    }
  });
}

/** OWNER_PID and its neighbour are gone; anything else is alive. */
const ownerGone = {
  hostname: hostname(),
  isDead: (pid: number) => pid === OWNER_PID || pid === OWNER_PID + 1,
};

Deno.test("cancelLocalRun: cancels the method runs and closes the rows an owner killed after its grace left running", async () => {
  await withKilledOwner(
    async ({ runRepo, outputRepo, tracker, dbPath, run, step, stranger }) => {
      const result = await cancelLocalRun(run, WORKFLOW, "No longer needed", {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        runTracker: tracker,
        outputRepo,
        liveness: ownerGone,
        killProcess: () => Promise.resolve(true),
      });

      assertEquals(result?.status, "cancelled");
      const settled = await outputRepo.findById(SHELL, "execute", step.id);
      assertEquals(settled?.status, "cancelled");
      assertEquals(settled?.error?.message, OWNER_STOPPED_STEP_ERROR);
      assertEquals(settled?.completedAt !== undefined, true);
      for (const id of [run.id, step.id]) {
        assertEquals(tracker.findById(id)?.status, "cancelled");
        assertEquals(cancelReasonOf(dbPath, id), "No longer needed");
      }
      // Another process's method run is not this cancel's to close.
      assertEquals(
        (await outputRepo.findById(SHELL, "execute", stranger.id))?.status,
        "running",
      );
      assertEquals(tracker.findById(stranger.id)?.status, "running");
    },
  );
});

Deno.test("cancelLocalRun: leaves the rows and method runs of an owner that is still alive", async () => {
  await withKilledOwner(
    async ({ runRepo, outputRepo, tracker, run, step }) => {
      await cancelLocalRun(run, WORKFLOW, "No longer needed", {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        runTracker: tracker,
        outputRepo,
        liveness: { hostname: hostname(), isDead: () => false },
        killProcess: () => Promise.resolve(true),
      });

      assertEquals(
        (await outputRepo.findById(SHELL, "execute", step.id))?.status,
        "running",
      );
      assertEquals(tracker.findById(step.id)?.status, "running");
      assertEquals(tracker.findById(run.id)?.status, "running");
    },
  );
});

Deno.test("cancelAllLocalRuns: closes what each killed owner left running", async () => {
  await withKilledOwner(
    async ({ runRepo, outputRepo, tracker, dbPath, run, step }) => {
      const result = await cancelAllLocalRuns(
        [{ run, workflow: WORKFLOW }],
        "Cancelled by user",
        {
          runRepo,
          findEvaluatedWorkflow: noSnapshot,
          runClaims: unclaimedRuns,
          runTracker: tracker,
          outputRepo,
          liveness: ownerGone,
          killProcess: () => Promise.resolve(true),
        },
      );

      assertEquals(result.cancelled.map((c) => c.runId), [run.id]);
      assertEquals(
        (await outputRepo.findById(SHELL, "execute", step.id))?.status,
        "cancelled",
      );
      assertEquals(tracker.findById(step.id)?.status, "cancelled");
      assertEquals(cancelReasonOf(dbPath, step.id), "Cancelled by user");
    },
  );
});

Deno.test("cancelLocalRun: keeps the row of another run the killed owner drove, for run doctor", async () => {
  await withKilledOwner(
    async ({ runRepo, outputRepo, tracker, run, step }) => {
      // A nested child run shares its parent's process; this cancel does not
      // settle its record, so its row must stay as evidence.
      const childId = crypto.randomUUID();
      tracker.register(ownerRow(childId, OWNER_PID, "workflow"));

      await cancelLocalRun(run, WORKFLOW, "No longer needed", {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        runTracker: tracker,
        outputRepo,
        liveness: ownerGone,
        killProcess: () => Promise.resolve(true),
      });

      assertEquals(tracker.findById(run.id)?.status, "cancelled");
      assertEquals(tracker.findById(step.id)?.status, "cancelled");
      assertEquals(tracker.findById(childId)?.status, "running");
    },
  );
});

/** An output repository whose reads fail, as an unreadable directory does. */
const unreadableOutputs = {
  findByIds: () => Promise.reject(new Error("permission denied")),
  save: () => Promise.reject(new Error("unexpected output save")),
} as MethodRunOutputs;

Deno.test("cancelLocalRun: an unreadable method-run record still lets the cancel settle the run", async () => {
  await withKilledOwner(async ({ runRepo, tracker, run, step }) => {
    const result = await cancelLocalRun(run, WORKFLOW, "No longer needed", {
      runRepo,
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
      runTracker: tracker,
      outputRepo: unreadableOutputs,
      liveness: ownerGone,
      killProcess: () => Promise.resolve(true),
    });

    assertEquals(result?.status, "cancelled");
    assertEquals(tracker.findById(run.id)?.status, "cancelled");
    // Left for run doctor --fix, which settles an interrupted dead-pid row.
    assertEquals(tracker.findById(step.id)?.status, "interrupted");
  });
});

Deno.test("cancelAllLocalRuns: an unreadable method-run record does not stop the batch", async () => {
  await withKilledOwner(async ({ runRepo, tracker, run, step }) => {
    const result = await cancelAllLocalRuns(
      [{ run, workflow: WORKFLOW }],
      "Cancelled by user",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        runTracker: tracker,
        outputRepo: unreadableOutputs,
        liveness: ownerGone,
        killProcess: () => Promise.resolve(true),
      },
    );

    assertEquals(result.cancelled.map((c) => c.runId), [run.id]);
    assertEquals(tracker.findById(step.id)?.status, "interrupted");
  });
});

// swamp-club#2920: a run whose workflow file was deleted.

/** A run suspended at its gate, as `workflow run` saved it. */
function gatedRunData(
  overrides: Partial<WorkflowRunInput> = {},
): WorkflowRunInput {
  return {
    id: crypto.randomUUID(),
    workflowId: WORKFLOW_ID,
    workflowName: "test-workflow",
    status: "suspended",
    startedAt: "2026-07-20T20:00:00.000Z",
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt: "2026-07-20T20:00:00.000Z",
      steps: [
        {
          stepName: "gate",
          status: "waiting_approval",
          startedAt: "2026-07-20T20:00:00.000Z",
        },
        { stepName: "deploy", status: "pending" },
      ],
    }],
    tags: {},
    ...overrides,
  };
}

/** The gated workflow: `deploy` runs once `gate` is approved. */
function gatedWorkflow(id: string = WORKFLOW_ID, name = "test-workflow") {
  return Workflow.create({
    id,
    name,
    jobs: [Job.create({
      name: "main",
      steps: [
        Step.create({ name: "gate", task: StepTask.manualApproval("ok?") }),
        Step.create({
          name: "deploy",
          task: StepTask.model("m", "run"),
          dependsOn: [{
            step: "gate",
            condition: TriggerCondition.succeeded(),
          }],
        }),
      ],
    })],
  });
}

/** What cancel looks runs up through, with `workflows` as the definitions. */
function lookup(
  runRepo: YamlWorkflowRunRepository,
  workflows: Workflow[] = [],
  broken: BrokenWorkflow[] = [],
): CancelTargetDeps {
  return {
    workflowRepo: definitions(...workflows),
    runRepo,
    listBrokenWorkflows: () => Promise.resolve(broken),
  };
}

/** A workflow repository holding only `workflows`. */
function definitions(
  ...workflows: Workflow[]
): CancelTargetDeps["workflowRepo"] {
  return {
    findByName: (name) =>
      Promise.resolve(workflows.find((w) => w.name === name) ?? null),
    findById: (id) =>
      Promise.resolve(workflows.find((w) => w.id === id) ?? null),
    findAll: () => Promise.resolve(workflows),
  };
}

Deno.test("cancelLocalRun: settles a run whose definition is gone from its records alone", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const run = WorkflowRun.fromData(gatedRunData());
    await runRepo.save(workflowId, run);

    const result = await cancelLocalRun(run, undefined, "No longer needed", {
      runRepo,
      findEvaluatedWorkflow: noSnapshot,
      runClaims: unclaimedRuns,
      ...untracked,
    });

    const stored = await runRepo.findById(workflowId, run.id);
    for (const settled of [result, stored]) {
      assertEquals(settled?.status, "cancelled");
      assertEquals(settled?.tags.cancel_reason, "No longer needed");
      assertEquals(settled?.jobs[0].status, "failed");
      assertEquals(stepSummary(settled!), ["gate:failed", "deploy:failed"]);
      assertEquals(settled?.jobs[0].steps[0].error, "cancelled");
    }
  });
});

Deno.test("cancelLocalRun: settles a run whose definition is gone against its evaluated snapshot", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const snapshotId = crypto.randomUUID();
    const run = WorkflowRun.fromData(gatedRunData({
      runPlan: { fingerprint: "f", evaluatedWorkflowId: snapshotId },
    }));
    await runRepo.save(workflowId, run);

    const lookedUp: string[] = [];
    const result = await cancelLocalRun(run, undefined, "No longer needed", {
      runRepo,
      findEvaluatedWorkflow: (id) => {
        lookedUp.push(id);
        return Promise.resolve(gatedWorkflow());
      },
      runClaims: unclaimedRuns,
      ...untracked,
    });

    assertEquals(lookedUp, [snapshotId]);
    assertEquals(result?.status, "cancelled");
    // The snapshot's dependsOn decides: deploy needed the gate to succeed.
    assertEquals(stepSummary(result!), ["gate:failed", "deploy:skipped"]);
    assertEquals(result?.jobs[0].steps[1].skipReason, { kind: "dependency" });
  });
});

Deno.test("cancelAllLocalRuns: reports a run whose definition is gone under its recorded name", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const workflowId = createWorkflowId(WORKFLOW_ID);
    const run = WorkflowRun.fromData(gatedRunData({ workflowName: "gone" }));
    await runRepo.save(workflowId, run);

    const result = await cancelAllLocalRuns(
      [{ run, workflow: undefined }],
      "Cancelled by user",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: unclaimedRuns,
        ...untracked,
      },
    );

    assertEquals(result.cancelled, [{
      runId: run.id,
      workflowName: "gone",
      previousStatus: "suspended",
    }]);
    assertEquals(
      (await runRepo.findById(workflowId, run.id))?.status,
      "cancelled",
    );
  });
});

Deno.test("cancelAllLocalRuns: a claim that times out reports a run whose definition is gone as not cancelled", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const run = WorkflowRun.fromData(gatedRunData({ workflowName: "gone" }));
    await runRepo.save(createWorkflowId(WORKFLOW_ID), run);
    const timedOut: WorkflowRunClaims = {
      withClaim: () => Promise.reject(new LockTimeoutError("claim", null, 1)),
    };

    const result = await cancelAllLocalRuns(
      [{ run, workflow: undefined }],
      "Cancelled by user",
      {
        runRepo,
        findEvaluatedWorkflow: noSnapshot,
        runClaims: timedOut,
        ...untracked,
      },
    );

    assertEquals(result.claimTimedOut, true);
    assertEquals(
      result.notCancelled.map((n) => [n.runId, n.workflowName, n.status]),
      [[run.id, "gone", "suspended"]],
    );
  });
});

const OTHER_WORKFLOW_ID = "b0000000-0000-4000-8000-000000000002";

/** Saves a suspended run under `workflowId` and returns it. */
async function saveGatedRun(
  runRepo: YamlWorkflowRunRepository,
  overrides: Partial<WorkflowRunInput> = {},
): Promise<WorkflowRun> {
  const run = WorkflowRun.fromData(gatedRunData(overrides));
  await runRepo.save(createWorkflowId(run.workflowId), run);
  return run;
}

Deno.test("resolveLocalCancelTarget: finds a run whose definition is gone by its run id alone", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const run = await saveGatedRun(runRepo);

    const target = await resolveLocalCancelTarget(
      lookup(runRepo),
      { runId: run.id },
    );

    assertEquals(target.run.id, run.id);
    assertEquals(target.workflow, undefined);
  });
});

Deno.test("resolveLocalCancelTarget: a run id with the deleted workflow's recorded name or id finds the run", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const run = await saveGatedRun(runRepo);

    for (const workflowIdOrName of ["test-workflow", WORKFLOW_ID]) {
      const target = await resolveLocalCancelTarget(
        lookup(runRepo),
        { workflowIdOrName, runId: run.id },
      );
      assertEquals(target.run.id, run.id);
      assertEquals(target.workflow, undefined);
    }
  });
});

Deno.test("resolveLocalCancelTarget: a run id returns the run's definition when it exists", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const run = await saveGatedRun(runRepo);
    // Renamed since the run recorded "test-workflow".
    const renamed = gatedWorkflow(WORKFLOW_ID, "renamed");
    const deps = lookup(runRepo, [renamed]);

    for (
      const workflowIdOrName of [undefined, "renamed", "test-workflow"]
    ) {
      const target = await resolveLocalCancelTarget(deps, {
        workflowIdOrName,
        runId: run.id,
      });
      assertEquals(target.run.id, run.id);
      assertEquals(target.workflow, renamed);
    }
  });
});

Deno.test("resolveLocalCancelTarget: a run of another workflow than the one named is not found", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const run = await saveGatedRun(runRepo);
    const other = gatedWorkflow(OTHER_WORKFLOW_ID, "other");
    const deps = lookup(runRepo, [other]);

    await assertRejects(
      () =>
        resolveLocalCancelTarget(deps, {
          workflowIdOrName: "other",
          runId: run.id,
        }),
      UserError,
      `Workflow run not found: ${run.id}`,
    );
    await assertRejects(
      () =>
        resolveLocalCancelTarget(deps, {
          workflowIdOrName: "nope",
          runId: run.id,
        }),
      UserError,
      "Workflow not found: nope",
    );
  });
});

Deno.test("resolveLocalCancelTarget: an unknown run id is not found, whatever its form", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    await saveGatedRun(runRepo);
    const deps = lookup(runRepo, [gatedWorkflow()]);

    for (const runId of [crypto.randomUUID(), "not-a-uuid", "../escape"]) {
      await assertRejects(
        () => resolveLocalCancelTarget(deps, { runId }),
        UserError,
        `Workflow run not found: ${runId}`,
      );
      await assertRejects(
        () =>
          resolveLocalCancelTarget(deps, {
            workflowIdOrName: "test-workflow",
            runId,
          }),
        UserError,
        `Workflow run not found: ${runId}`,
      );
      await assertRejects(
        () =>
          resolveLocalCancelTarget(deps, { workflowIdOrName: "nope", runId }),
        UserError,
        "Workflow not found: nope",
      );
    }
  });
});

Deno.test("resolveLocalCancelTarget: a workflow alone picks its latest active run", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    await saveGatedRun(runRepo, { startedAt: "2026-07-20T20:00:00.000Z" });
    const latest = await saveGatedRun(runRepo, {
      startedAt: "2026-07-20T21:00:00.000Z",
    });
    await saveGatedRun(runRepo, {
      startedAt: "2026-07-20T22:00:00.000Z",
      status: "cancelled",
      completedAt: "2026-07-20T22:00:01.000Z",
    });
    const workflow = gatedWorkflow();

    const target = await resolveLocalCancelTarget(
      lookup(runRepo, [workflow]),
      { workflowIdOrName: "test-workflow" },
    );

    assertEquals(target.run.id, latest.id);
    assertEquals(target.workflow, workflow);
  });
});

Deno.test("resolveLocalCancelTarget: a workflow with a definition and no active run says so", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);

    await assertRejects(
      () =>
        resolveLocalCancelTarget(
          lookup(runRepo, [gatedWorkflow()]),
          { workflowIdOrName: "test-workflow" },
        ),
      UserError,
      'No active runs found for workflow "test-workflow"',
    );
  });
});

Deno.test("resolveLocalCancelTarget: a deleted workflow's name or id picks its latest active run", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    await saveGatedRun(runRepo, { startedAt: "2026-07-20T20:00:00.000Z" });
    const latest = await saveGatedRun(runRepo, {
      startedAt: "2026-07-20T21:00:00.000Z",
    });
    // Another deleted workflow's run, and a live workflow's.
    await saveGatedRun(runRepo, {
      workflowId: OTHER_WORKFLOW_ID,
      workflowName: "other",
      startedAt: "2026-07-20T23:00:00.000Z",
    });
    const deps = lookup(runRepo);

    for (const workflowIdOrName of ["test-workflow", WORKFLOW_ID]) {
      const target = await resolveLocalCancelTarget(deps, {
        workflowIdOrName,
      });
      assertEquals(target.run.id, latest.id);
      assertEquals(target.workflow, undefined);
    }
  });
});

Deno.test("resolveLocalCancelTarget: a name no definition or active run carries is not found", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    // The deleted workflow's only run already finished.
    await saveGatedRun(runRepo, {
      status: "cancelled",
      completedAt: "2026-07-20T22:00:01.000Z",
    });
    // A renamed workflow still has its definition: its old name is not a
    // deleted workflow's.
    await saveGatedRun(runRepo, {
      workflowId: OTHER_WORKFLOW_ID,
      workflowName: "old-name",
    });
    const deps = lookup(runRepo, [
      gatedWorkflow(OTHER_WORKFLOW_ID, "new-name"),
    ]);

    for (const workflowIdOrName of ["test-workflow", "old-name", "nope"]) {
      await assertRejects(
        () => resolveLocalCancelTarget(deps, { workflowIdOrName }),
        UserError,
        `Workflow not found: ${workflowIdOrName}`,
      );
    }
  });
});

Deno.test("resolveLocalCancelTarget: a name reused by a newer workflow means the newer one", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const orphaned = await saveGatedRun(runRepo);
    const reused = gatedWorkflow(OTHER_WORKFLOW_ID, "test-workflow");
    const deps = lookup(runRepo, [reused]);

    await assertRejects(
      () =>
        resolveLocalCancelTarget(deps, { workflowIdOrName: "test-workflow" }),
      UserError,
      'No active runs found for workflow "test-workflow"',
    );
    // The deleted workflow's run stays reachable by its run id.
    const target = await resolveLocalCancelTarget(deps, {
      runId: orphaned.id,
    });
    assertEquals(target.run.id, orphaned.id);
    assertEquals(target.workflow, undefined);
  });
});

Deno.test("findAllActiveRuns: includes the active runs of deleted workflows", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const defined = await saveGatedRun(runRepo);
    const orphaned = await saveGatedRun(runRepo, {
      workflowId: OTHER_WORKFLOW_ID,
      workflowName: "gone",
    });
    await saveGatedRun(runRepo, {
      workflowId: OTHER_WORKFLOW_ID,
      workflowName: "gone",
      status: "cancelled",
      completedAt: "2026-07-20T22:00:01.000Z",
    });
    const workflow = gatedWorkflow();

    const active = await findAllActiveRuns(lookup(runRepo, [workflow]));

    assertEquals(
      new Map(active.active.map(({ run, workflow }) => [run.id, workflow])),
      new Map([[defined.id, workflow], [orphaned.id, undefined]]),
    );
    assertEquals(active.unloadable, []);
  });
});

Deno.test("findAllActiveRuns: groups runs by workflow in definition order, deleted workflows last", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const THIRD_WORKFLOW_ID = "c0000000-0000-4000-8000-000000000003";
    // Start times interleave the three workflows.
    const firstOld = await saveGatedRun(runRepo, {
      startedAt: "2026-07-20T20:00:00.000Z",
    });
    const orphaned = await saveGatedRun(runRepo, {
      workflowId: THIRD_WORKFLOW_ID,
      workflowName: "gone",
      startedAt: "2026-07-20T23:00:00.000Z",
    });
    const second = await saveGatedRun(runRepo, {
      workflowId: OTHER_WORKFLOW_ID,
      workflowName: "other",
      startedAt: "2026-07-20T21:00:00.000Z",
    });
    const firstNew = await saveGatedRun(runRepo, {
      startedAt: "2026-07-20T22:00:00.000Z",
    });

    const active = await findAllActiveRuns(
      lookup(runRepo, [
        gatedWorkflow(),
        gatedWorkflow(OTHER_WORKFLOW_ID, "other"),
      ]),
    );

    assertEquals(
      active.active.map(({ run, workflow }) => [run.id, workflow?.name]),
      [
        [firstNew.id, "test-workflow"],
        [firstOld.id, "test-workflow"],
        [second.id, "other"],
        [orphaned.id, undefined],
      ],
    );
  });
});

/** A workflow file that fails to load, as `listBrokenWorkflows` reports it. */
function brokenFile(overrides: Partial<BrokenWorkflow> = {}): BrokenWorkflow {
  return {
    file: "/repo/workflows/workflow-test-workflow.yaml",
    id: WORKFLOW_ID,
    name: "test-workflow",
    error: "bad indentation at line 4, column 1:\n    jobs: [\n    ^",
    ...overrides,
  };
}

/** Writes a run file that is not valid YAML into `workflowId`'s directory. */
async function saveDamagedRun(
  runRepo: YamlWorkflowRunRepository,
  workflowId: string,
): Promise<void> {
  const path = runRepo.getPath(
    createWorkflowId(workflowId),
    createWorkflowRunId(crypto.randomUUID()),
  );
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, "id: x\njobs: [\n");
}

Deno.test("resolveLocalCancelTarget: a damaged run file elsewhere does not break a deleted or mistyped name", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const run = await saveGatedRun(runRepo);
    // Damaged records under a workflow with a definition and under another
    // deleted workflow.
    await saveDamagedRun(runRepo, OTHER_WORKFLOW_ID);
    await saveDamagedRun(runRepo, "c0000000-0000-4000-8000-000000000003");
    const deps = lookup(runRepo, [gatedWorkflow(OTHER_WORKFLOW_ID, "other")]);

    const target = await resolveLocalCancelTarget(deps, {
      workflowIdOrName: "test-workflow",
    });
    assertEquals(target.run.id, run.id);
    await assertRejects(
      () => resolveLocalCancelTarget(deps, { workflowIdOrName: "typo" }),
      UserError,
      "Workflow not found: typo",
    );
  });
});

Deno.test("resolveLocalCancelTarget: a name no definition carries loads only the runs that could be its own", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    // A workflow with a definition, a deleted one with another name, and the
    // deleted one named: one finished run and one active.
    await saveGatedRun(runRepo, {
      workflowId: OTHER_WORKFLOW_ID,
      workflowName: "other",
    });
    await saveGatedRun(runRepo, {
      workflowId: "c0000000-0000-4000-8000-000000000003",
      workflowName: "gone",
    });
    await saveGatedRun(runRepo, {
      status: "cancelled",
      completedAt: "2026-07-20T22:00:01.000Z",
    });
    const active = await saveGatedRun(runRepo);
    const loaded: string[] = [];
    const counting = Object.create(runRepo) as YamlWorkflowRunRepository;
    counting.findById = (workflowId, runId) => {
      loaded.push(runId);
      return runRepo.findById(workflowId, runId);
    };
    counting.findAllByWorkflowId = () =>
      Promise.reject(new Error("unexpected full read of a run directory"));
    counting.findAllGlobal = () =>
      Promise.reject(new Error("unexpected full read of the run store"));
    const deps = lookup(counting, [gatedWorkflow(OTHER_WORKFLOW_ID, "other")]);

    const target = await resolveLocalCancelTarget(deps, {
      workflowIdOrName: "test-workflow",
    });
    assertEquals(target.run.id, active.id);
    assertEquals(loaded, [active.id]);

    loaded.length = 0;
    await assertRejects(
      () => resolveLocalCancelTarget(deps, { workflowIdOrName: "typo" }),
      UserError,
      "Workflow not found: typo",
    );
    assertEquals(loaded, []);
  });
});

Deno.test("resolveLocalCancelTarget: a workflow whose file fails to load is not a deleted one", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const run = await saveGatedRun(runRepo);

    // The file names the workflow by id, by name, or only by its file name.
    for (
      const broken of [
        brokenFile({ name: null }),
        brokenFile({ id: null }),
        brokenFile({ id: null, name: null }),
        brokenFile({
          id: null,
          name: null,
          file: `/repo/workflows/workflow-${WORKFLOW_ID}.yaml`,
        }),
      ]
    ) {
      const deps = lookup(runRepo, [], [broken]);
      const error = await assertRejects(
        () =>
          resolveLocalCancelTarget(deps, {
            workflowIdOrName: "test-workflow",
          }),
        UserError,
      );
      assertEquals(
        error.message,
        `Workflow file ${broken.file} could not be loaded (bad indentation at line 4, column 1), so run ${run.id} was left as it is. ` +
          `Fix the file, or cancel the run by its id: swamp workflow cancel --run ${run.id}`,
      );
      // Naming the run cancels it whatever state its workflow file is in.
      const target = await resolveLocalCancelTarget(deps, { runId: run.id });
      assertEquals(target.run.id, run.id);
    }
  });
});

Deno.test("resolveLocalCancelTarget: another workflow's broken file does not hold back a deleted workflow's run", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const run = await saveGatedRun(runRepo);
    const deps = lookup(runRepo, [], [
      brokenFile({
        id: OTHER_WORKFLOW_ID,
        name: "other",
        file: "/repo/workflows/workflow-other.yaml",
      }),
    ]);

    const target = await resolveLocalCancelTarget(deps, {
      workflowIdOrName: "test-workflow",
    });
    assertEquals(target.run.id, run.id);
  });
});

Deno.test("findAllActiveRuns: sets apart the runs of a workflow whose file fails to load", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    const unloadable = await saveGatedRun(runRepo);
    const orphaned = await saveGatedRun(runRepo, {
      workflowId: OTHER_WORKFLOW_ID,
      workflowName: "gone",
    });
    const broken = brokenFile();

    const found = await findAllActiveRuns(lookup(runRepo, [], [broken]));

    assertEquals(
      found.active.map(({ run, workflow }) => [run.id, workflow]),
      [[orphaned.id, undefined]],
    );
    assertEquals(
      found.unloadable.map((entry) => [entry.run.id, entry.broken]),
      [[unloadable.id, broken]],
    );
  });
});

Deno.test("findAllActiveRuns: a damaged run file under a deleted workflow fails the lookup", async () => {
  await withTempDir(async (dir) => {
    const runRepo = new YamlWorkflowRunRepository(dir);
    await saveGatedRun(runRepo);
    await saveDamagedRun(runRepo, OTHER_WORKFLOW_ID);

    await assertRejects(() => findAllActiveRuns(lookup(runRepo)));
  });
});

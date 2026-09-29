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

import { assertEquals, assertGreater } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  normalizeFireTime,
  type PendingRunHook,
  type ScheduledExecutionEvent,
  ScheduledExecutionService,
  type WorkflowExecutor,
} from "./scheduled_execution.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRunEvent, WorkflowRunInput } from "./run.ts";

function createTestWorkflow(
  name: string,
  schedule?: string,
): Workflow {
  const step = Step.fromData({
    name: "step1",
    task: {
      type: "model_method",
      modelIdOrName: "test",
      methodName: "execute",
    },
    dependsOn: [],
    weight: 0,
    allowFailure: false,
  });
  const job = Job.fromData({
    name: "job1",
    steps: [step.toData()],
    dependsOn: [],
    weight: 0,
  });
  return Workflow.create({
    name,
    trigger: schedule ? { schedule } : undefined,
    jobs: [job],
  });
}

function createMockWorkflowRepo(
  workflows: Workflow[],
): WorkflowRepository {
  return {
    findAll: () => Promise.resolve(workflows),
    findById: (id: WorkflowId) =>
      Promise.resolve(workflows.find((w) => w.id === id) ?? null),
    findByName: (name: string) =>
      Promise.resolve(workflows.find((w) => w.name === name) ?? null),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => crypto.randomUUID() as WorkflowId,
    getPath: () => "",
  };
}

Deno.test("ScheduledExecutionService: registers schedules from existing workflows", async () => {
  const wf = createTestWorkflow("scheduled-wf", "0 * * * *");
  const events: ScheduledExecutionEvent[] = [];

  const mockRepo = createMockWorkflowRepo([wf]);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
  });

  await service.start((e) => events.push(e));

  // Should have registered the schedule
  const schedules = service.listSchedules();
  assertEquals(schedules.length, 1);
  assertEquals(schedules[0].cronExpression, "0 * * * *");
  assertEquals(schedules[0].workflowName, "scheduled-wf");

  // Should have emitted a registration event
  const registered = events.filter((e) => e.kind === "schedule_registered");
  assertEquals(registered.length, 1);

  await service.stop();
});

Deno.test("ScheduledExecutionService: ignores workflows without schedules", async () => {
  const wf = createTestWorkflow("no-schedule-wf");
  const events: ScheduledExecutionEvent[] = [];

  const mockRepo = createMockWorkflowRepo([wf]);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
  });

  await service.start((e) => events.push(e));

  assertEquals(service.listSchedules().length, 0);
  assertEquals(events.length, 0);

  await service.stop();
});

Deno.test("ScheduledExecutionService: emits schedule_failed when workflow run has failed status", async () => {
  const wf = createTestWorkflow("fail-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];

  const mockRepo = createMockWorkflowRepo([wf]);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: (
      _input,
      _signal,
      onEvent: (event: WorkflowRunEvent) => void,
    ) => {
      onEvent({
        kind: "started",
        runId: "run-1",
        workflowName: "fail-wf",
        jobs: [],
      });
      onEvent({
        kind: "completed",
        run: {
          id: "run-1",
          workflowId: wf.id,
          workflowName: "fail-wf",
          status: "failed",
          jobs: [{
            name: "job1",
            status: "failed",
            steps: [{
              name: "step1",
              status: "failed",
              error: "CEL type mismatch",
            }],
          }],
        },
      });
      return Promise.resolve();
    },
  });

  await service.start((e) => events.push(e));

  // Wait for the cron to fire (every second)
  await waitFor(
    () => events.some((e) => e.kind === "schedule_failed"),
    "schedule_failed event",
  );
  await service.stop();

  const failed = events.filter((e) => e.kind === "schedule_failed");
  assertEquals(failed.length >= 1, true);
  for (const event of failed) {
    assertEquals(
      (event as { kind: "schedule_failed"; error: string }).error,
      "CEL type mismatch",
    );
  }

  const completed = events.filter((e) => e.kind === "schedule_completed");
  assertEquals(completed.length, 0);
});

Deno.test("ScheduledExecutionService: emits schedule_failed when workflow yields error event without completed", async () => {
  const wf = createTestWorkflow("error-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];

  const mockRepo = createMockWorkflowRepo([wf]);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: (
      _input,
      _signal,
      onEvent: (event: WorkflowRunEvent) => void,
    ) => {
      onEvent({
        kind: "started",
        runId: "run-1",
        workflowName: "error-wf",
        jobs: [],
      });
      onEvent({
        kind: "error",
        error: {
          code: "workflow_execution_failed",
          message: "Unknown model type: @acme/missing",
        },
      });
      return Promise.resolve();
    },
  });

  await service.start((e) => events.push(e));

  await waitFor(
    () => events.some((e) => e.kind === "schedule_failed"),
    "schedule_failed event",
  );
  await service.stop();

  const failed = events.filter((e) => e.kind === "schedule_failed");
  assertEquals(failed.length >= 1, true);
  for (const event of failed) {
    assertEquals(
      (event as { kind: "schedule_failed"; error: string }).error,
      "Unknown model type: @acme/missing",
    );
  }

  const completed = events.filter((e) => e.kind === "schedule_completed");
  assertEquals(completed.length, 0);
});

Deno.test("ScheduledExecutionService: emits schedule_failed when no terminal event is yielded", async () => {
  const wf = createTestWorkflow("silent-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];

  const mockRepo = createMockWorkflowRepo([wf]);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
  });

  await service.start((e) => events.push(e));

  await waitFor(
    () => events.some((e) => e.kind === "schedule_failed"),
    "schedule_failed event",
  );
  await service.stop();

  const failed = events.filter((e) => e.kind === "schedule_failed");
  assertEquals(failed.length >= 1, true);
  for (const event of failed) {
    assertEquals(
      (event as { kind: "schedule_failed"; error: string }).error,
      "workflow did not complete",
    );
  }

  const completed = events.filter((e) => e.kind === "schedule_completed");
  assertEquals(completed.length, 0);
});

Deno.test("ScheduledExecutionService: emits schedule_suspended when workflow yields suspended event", async () => {
  const wf = createTestWorkflow("gated-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];

  const mockRepo = createMockWorkflowRepo([wf]);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: (
      _input,
      _signal,
      onEvent: (event: WorkflowRunEvent) => void,
    ) => {
      onEvent({
        kind: "started",
        runId: "run-1",
        workflowName: "gated-wf",
        jobs: [],
      });
      onEvent({
        kind: "suspended",
        run: {
          id: "run-1",
          workflowId: wf.id,
          workflowName: "gated-wf",
          status: "suspended",
          jobs: [{
            name: "job1",
            status: "running",
            steps: [{
              name: "step1",
              status: "running",
            }],
          }],
        },
        jobId: "job1",
        stepId: "step1",
        prompt: "Approve deployment?",
      });
      return Promise.resolve();
    },
  });

  await service.start((e) => events.push(e));

  await waitFor(
    () => events.some((e) => e.kind === "schedule_suspended"),
    "schedule_suspended event",
  );
  await service.stop();

  const suspended = events.filter((e) => e.kind === "schedule_suspended");
  assertEquals(suspended.length >= 1, true);
  for (const event of suspended) {
    assertEquals(
      (event as { kind: "schedule_suspended"; runId: string }).runId,
      "run-1",
    );
  }

  const failed = events.filter((e) => e.kind === "schedule_failed");
  assertEquals(failed.length, 0);

  const completed = events.filter((e) => e.kind === "schedule_completed");
  assertEquals(completed.length, 0);
});

Deno.test("ScheduledExecutionService: stop clears schedules", async () => {
  const wf = createTestWorkflow("scheduled-wf", "0 * * * *");

  const mockRepo = createMockWorkflowRepo([wf]);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
  });

  await service.start();
  assertEquals(service.listSchedules().length, 1);

  await service.stop();
  assertEquals(service.listSchedules().length, 0);
});

// ── Drain (swamp-club#2484) ──────────────────────────────────────────

/** An executor whose runs stay in flight until released or aborted. */
function createBlockingExecutor() {
  const gate = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const executeWorkflow: WorkflowExecutor = (input, signal, onEvent) => {
    signals.push(signal);
    onEvent({
      kind: "started",
      runId: `run-${signals.length}`,
      workflowName: input.workflowIdOrName,
      jobs: [],
    });
    return new Promise<void>((resolve) => {
      gate.promise.then(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  return { executeWorkflow, signals, release: () => gate.resolve() };
}

Deno.test("ScheduledExecutionService.drain: waits for the in-flight run to finish without aborting it", async () => {
  const executor = createBlockingExecutor();
  // A far-off schedule gives the test a visible sign that the drain has
  // stopped the scheduler and reached its wait.
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([
      createTestWorkflow("yearly-wf", "0 0 1 1 *"),
    ]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
  });
  await service.start();
  service.enqueueForReplay({ pendingRunId: "p-1", workflowIdOrName: "wf" });
  await waitFor(() => executor.signals.length === 1, "run started");

  const order: string[] = [];
  const drain = service.drain(60_000).then(() => order.push("drained"));
  await waitFor(() => service.listSchedules().length === 0, "scheduler stop");

  order.push("released");
  executor.release();
  await drain;
  assertEquals(order, ["released", "drained"]);
  assertEquals(executor.signals[0].aborted, false);
  await service.stop();
});

Deno.test("ScheduledExecutionService.drain: returns at the timeout and stop then aborts the run", async () => {
  const executor = createBlockingExecutor();
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
  });
  await service.start();
  service.enqueueForReplay({ pendingRunId: "p-1", workflowIdOrName: "wf" });
  await waitFor(() => executor.signals.length === 1, "run started");

  await service.drain(1);
  assertEquals(executor.signals[0].aborted, false);

  await service.stop();
  assertEquals(executor.signals[0].aborted, true);
});

// ── Cancel reason (swamp-club#2651) ─────────────────────────────────

/** A service with one scheduled run in flight, run-1. */
async function withRunInFlight(
  fn: (
    service: ScheduledExecutionService,
    signal: AbortSignal,
  ) => void | Promise<void>,
): Promise<void> {
  const executor = createBlockingExecutor();
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
  });
  await service.start();
  try {
    service.enqueueForReplay({ pendingRunId: "p-1", workflowIdOrName: "wf" });
    await waitFor(() => executor.signals.length === 1, "run started");
    await fn(service, executor.signals[0]);
  } finally {
    await service.stop();
  }
}

function abortMessage(signal: AbortSignal): string | undefined {
  return signal.reason instanceof Error ? signal.reason.message : undefined;
}

Deno.test("ScheduledExecutionService.cancelByRunId: aborts the run with the reason given", async () => {
  await withRunInFlight((service, signal) => {
    assertEquals(
      service.cancelByRunId("run-1", "cancelled by user:alice"),
      true,
    );
    assertEquals(abortMessage(signal), "cancelled by user:alice");
  });
});

Deno.test("ScheduledExecutionService.cancelByRunId: leaves the run alone for an unknown id", async () => {
  await withRunInFlight((service, signal) => {
    assertEquals(
      service.cancelByRunId("run-9", "cancelled by user:alice"),
      false,
    );
    assertEquals(signal.aborted, false);
  });
});

Deno.test("ScheduledExecutionService.cancelAllRuns: aborts every run with the reason given", async () => {
  await withRunInFlight((service, signal) => {
    assertEquals(service.cancelAllRuns("cancelled by user:bob"), 1);
    assertEquals(abortMessage(signal), "cancelled by user:bob");
  });
});

Deno.test("ScheduledExecutionService: cancels with the default reason when none is given", async () => {
  await withRunInFlight((service, signal) => {
    assertEquals(service.cancelByRunId("run-1"), true);
    assertEquals(abortMessage(signal), "cancelled by user");
  });
  await withRunInFlight((service, signal) => {
    assertEquals(service.cancelAllRuns(), 1);
    assertEquals(abortMessage(signal), "cancelled by user");
  });
});

Deno.test("ScheduledExecutionService.drain: drops queued runs but keeps their pending entries", async () => {
  const executor = createBlockingExecutor();
  const deleted: string[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    pendingRunHook: {
      enqueue: () => Promise.resolve(),
      delete: (id) => {
        deleted.push(id);
        return Promise.resolve();
      },
    },
  });
  await service.start();
  service.enqueueForReplay({ pendingRunId: "p-1", workflowIdOrName: "wf-a" });
  service.enqueueForReplay({ pendingRunId: "p-2", workflowIdOrName: "wf-b" });
  await waitFor(() => executor.signals.length === 1, "first run started");

  await service.drain(0);
  service.enqueueForReplay({ pendingRunId: "p-3", workflowIdOrName: "wf-c" });
  executor.release();
  await service.stop();

  assertEquals(executor.signals.length, 1);
  assertEquals(deleted, ["p-1"]);
});

Deno.test("ScheduledExecutionService.drain: waits for a fire claimed as the drain starts to be recorded for replay", async () => {
  // Fires every second, so more than one fire may reach the dedup gate
  // before the drain stops the scheduler; every one must be recorded.
  const wf = createTestWorkflow("drain-fire-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];
  const dedupGate = Promise.withResolvers<boolean>();
  const enqueueGate = Promise.withResolvers<void>();
  const enqueued: string[] = [];
  const deleted: string[] = [];
  let dedupCalls = 0;
  let executions = 0;
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => {
      executions++;
      return Promise.resolve();
    },
    cronFireDedup: () => {
      dedupCalls++;
      return dedupGate.promise;
    },
    pendingRunHook: {
      enqueue: async (entry) => {
        await enqueueGate.promise;
        enqueued.push(entry.workflowIdOrName);
      },
      delete: (id) => {
        deleted.push(id);
        return Promise.resolve();
      },
    },
  });
  await service.start((e) => events.push(e));
  await waitFor(() => dedupCalls > 0, "cron fire reached dedup");

  const order: string[] = [];
  const drain = service.drain(0).then(() => order.push("drained"));
  dedupGate.resolve(true);
  await waitFor(() => service.listSchedules().length === 0, "scheduler stop");
  order.push("released");
  enqueueGate.resolve();
  await drain;
  await service.stop();

  assertEquals(order, ["released", "drained"]);
  assertGreater(enqueued.length, 0);
  assertEquals(enqueued.every((name) => name === "drain-fire-wf"), true);
  assertEquals(deleted, []);
  assertEquals(executions, 0);
  assertEquals(events.filter((e) => e.kind === "schedule_fired").length, 0);
});

Deno.test("ScheduledExecutionService.drain: a run dequeued but not yet started stays pending", async () => {
  const wf = createTestWorkflow("dequeued-wf", "* * * * * *");
  const enqueueGate = Promise.withResolvers<void>();
  let enqueueCalls = 0;
  const deleted: string[] = [];
  let executions = 0;
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => {
      executions++;
      return Promise.resolve();
    },
    pendingRunHook: {
      enqueue: () => {
        enqueueCalls++;
        return enqueueGate.promise;
      },
      delete: (id) => {
        deleted.push(id);
        return Promise.resolve();
      },
    },
  });
  await service.start();
  // processQueue has taken the fire off the queue and waits on its write.
  await waitFor(() => enqueueCalls > 0, "fire enqueued");

  const drain = service.drain(0);
  enqueueGate.resolve();
  await drain;
  await service.stop();

  assertEquals(executions, 0);
  assertEquals(deleted, []);
});

Deno.test("ScheduledExecutionService: cronFireDedup returning true allows execution", async () => {
  const wf = createTestWorkflow("dedup-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];

  const mockRepo = createMockWorkflowRepo([wf]);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    cronFireDedup: () => Promise.resolve(true),
  });

  await service.start((e) => events.push(e));

  await waitFor(
    () => events.some((e) => e.kind === "schedule_fired"),
    "schedule_fired event",
  );
  await service.stop();

  const fired = events.filter((e) => e.kind === "schedule_fired");
  assertEquals(fired.length >= 1, true);
  const skipped = events.filter((e) =>
    e.kind === "schedule_skipped" &&
    (e as { dedupSkip?: boolean }).dedupSkip === true
  );
  assertEquals(skipped.length, 0);
});

Deno.test("ScheduledExecutionService: cronFireDedup returning false skips execution", async () => {
  const wf = createTestWorkflow("dedup-skip-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];

  const mockRepo = createMockWorkflowRepo([wf]);
  let executionCount = 0;
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => {
      executionCount++;
      return Promise.resolve();
    },
    cronFireDedup: () => Promise.resolve(false),
  });

  await service.start((e) => events.push(e));

  await waitFor(
    () => events.some((e) => e.kind === "schedule_skipped"),
    "schedule_skipped event",
  );
  await service.stop();

  const skipped = events.filter((e) =>
    e.kind === "schedule_skipped" &&
    (e as { dedupSkip?: boolean }).dedupSkip === true
  );
  assertEquals(skipped.length >= 1, true);

  const fired = events.filter((e) => e.kind === "schedule_fired");
  assertEquals(fired.length, 0);
  assertEquals(executionCount, 0);
});

Deno.test("ScheduledExecutionService: cronFireDedup error falls through to execution", async () => {
  const wf = createTestWorkflow("dedup-error-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];

  const mockRepo = createMockWorkflowRepo([wf]);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    cronFireDedup: () => Promise.reject(new Error("S3 unreachable")),
  });

  await service.start((e) => events.push(e));

  await waitFor(
    () => events.some((e) => e.kind === "schedule_fired"),
    "schedule_fired event",
  );
  await service.stop();

  const fired = events.filter((e) => e.kind === "schedule_fired");
  assertEquals(fired.length >= 1, true);
  const skipped = events.filter((e) =>
    e.kind === "schedule_skipped" &&
    (e as { dedupSkip?: boolean }).dedupSkip === true
  );
  assertEquals(skipped.length, 0);
});

Deno.test("ScheduledExecutionService: pendingRunHook delete awaits enqueue before running", async () => {
  const wf = createTestWorkflow("hook-order-wf", "* * * * * *");
  const ops: string[] = [];

  const hook: PendingRunHook = {
    enqueue: async (_entry) => {
      ops.push("enqueue-start");
      await new Promise<void>((r) => setTimeout(r, 50));
      ops.push("enqueue-done");
    },
    delete: (_id) => {
      ops.push("delete");
      return Promise.resolve();
    },
  };

  const mockRepo = createMockWorkflowRepo([wf]);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    pendingRunHook: hook,
  });

  await service.start();
  await waitFor(
    () => ops.includes("delete"),
    "pendingRunHook delete call",
  );
  await service.stop();

  assertGreater(ops.length, 2);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === "delete") {
      assertGreater(i, 0);
      assertEquals(ops[i - 1], "enqueue-done");
    }
  }
});

// ── Trigger Overrides ────────────────────────────────────────────────

Deno.test("ScheduledExecutionService: trigger override adds schedule to unscheduled workflow", async () => {
  const wf = createTestWorkflow("unscheduled-wf");
  const events: ScheduledExecutionEvent[] = [];

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    triggerOverrides: new Map([
      ["unscheduled-wf", { schedule: "0 3 * * *" }],
    ]),
  });

  await service.start((e) => events.push(e));

  const schedules = service.listSchedules();
  assertEquals(schedules.length, 1);
  assertEquals(schedules[0].cronExpression, "0 3 * * *");

  await service.stop();
});

Deno.test("ScheduledExecutionService: trigger override replaces existing schedule", async () => {
  const wf = createTestWorkflow("scheduled-wf", "0 12 * * *");
  const events: ScheduledExecutionEvent[] = [];

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    triggerOverrides: new Map([
      ["scheduled-wf", { schedule: "0 3 * * *" }],
    ]),
  });

  await service.start((e) => events.push(e));

  const schedules = service.listSchedules();
  assertEquals(schedules.length, 1);
  assertEquals(schedules[0].cronExpression, "0 3 * * *");

  await service.stop();
});

Deno.test("ScheduledExecutionService: trigger override for unknown workflow is skipped", async () => {
  const events: ScheduledExecutionEvent[] = [];

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    triggerOverrides: new Map([
      ["nonexistent-wf", { schedule: "0 3 * * *" }],
    ]),
  });

  await service.start((e) => events.push(e));

  const schedules = service.listSchedules();
  assertEquals(schedules.length, 0);

  await service.stop();
});

Deno.test("ScheduledExecutionService: trigger override inputs are passed to executeWorkflow at fire time", async () => {
  const wf = createTestWorkflow("input-override-wf", "* * * * * *");
  const capturedInputs: WorkflowRunInput[] = [];

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: (input, _signal, onEvent) => {
      capturedInputs.push(input);
      onEvent({
        kind: "started",
        runId: "run-1",
        workflowName: wf.name,
        jobs: [],
      });
      onEvent({
        kind: "completed",
        run: {
          id: "run-1",
          workflowId: wf.id,
          workflowName: wf.name,
          status: "succeeded",
          jobs: [],
        },
      });
      return Promise.resolve();
    },
    triggerOverrides: new Map([
      ["input-override-wf", { inputs: { channel: "#alerts", count: 5 } }],
    ]),
  });

  await service.start();
  await waitFor(
    () => capturedInputs.length > 0,
    "fire with override inputs",
  );
  await service.stop();

  assertGreater(capturedInputs.length, 0);
  assertEquals(capturedInputs[0].inputs, { channel: "#alerts", count: 5 });
});

Deno.test("ScheduledExecutionService: inputs-only override on unscheduled workflow is a no-op", async () => {
  const wf = createTestWorkflow("unscheduled-wf");

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    triggerOverrides: new Map([
      ["unscheduled-wf", { inputs: { channel: "#alerts" } }],
    ]),
  });

  await service.start();

  const schedules = service.listSchedules();
  assertEquals(schedules.length, 0);

  await service.stop();
});

Deno.test("ScheduledExecutionService: no trigger overrides works as before", async () => {
  const wf = createTestWorkflow("scheduled-wf", "0 * * * *");
  const events: ScheduledExecutionEvent[] = [];

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
  });

  await service.start((e) => events.push(e));

  const schedules = service.listSchedules();
  assertEquals(schedules.length, 1);
  assertEquals(schedules[0].cronExpression, "0 * * * *");

  await service.stop();
});

// ── updateTriggerOverrides ──────────────────────────────────────────

Deno.test("updateTriggerOverrides: adding a new override registers the schedule", async () => {
  const wf = createTestWorkflow("unscheduled-wf");
  const events: ScheduledExecutionEvent[] = [];

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
  });

  await service.start((e) => events.push(e));
  assertEquals(service.listSchedules().length, 0);

  const changed = await service.updateTriggerOverrides(
    new Map([["unscheduled-wf", { schedule: "0 6 * * *" }]]),
  );

  assertEquals(changed, 1);
  const schedules = service.listSchedules();
  assertEquals(schedules.length, 1);
  assertEquals(schedules[0].cronExpression, "0 6 * * *");

  await service.stop();
});

Deno.test("updateTriggerOverrides: changing an override re-registers with new schedule", async () => {
  const wf = createTestWorkflow("scheduled-wf", "0 12 * * *");
  const events: ScheduledExecutionEvent[] = [];

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    triggerOverrides: new Map([
      ["scheduled-wf", { schedule: "0 3 * * *" }],
    ]),
  });

  await service.start((e) => events.push(e));
  assertEquals(service.listSchedules()[0].cronExpression, "0 3 * * *");

  const changed = await service.updateTriggerOverrides(
    new Map([["scheduled-wf", { schedule: "0 6 * * *" }]]),
  );

  assertEquals(changed, 1);
  assertEquals(service.listSchedules()[0].cronExpression, "0 6 * * *");

  await service.stop();
});

Deno.test("updateTriggerOverrides: removing an override falls back to built-in schedule", async () => {
  const wf = createTestWorkflow("scheduled-wf", "0 12 * * *");

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    triggerOverrides: new Map([
      ["scheduled-wf", { schedule: "0 3 * * *" }],
    ]),
  });

  await service.start();
  assertEquals(service.listSchedules()[0].cronExpression, "0 3 * * *");

  const changed = await service.updateTriggerOverrides(new Map());

  assertEquals(changed, 1);
  assertEquals(service.listSchedules()[0].cronExpression, "0 12 * * *");

  await service.stop();
});

Deno.test("updateTriggerOverrides: removing override for override-only workflow unregisters it", async () => {
  const wf = createTestWorkflow("unscheduled-wf");

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    triggerOverrides: new Map([
      ["unscheduled-wf", { schedule: "0 3 * * *" }],
    ]),
  });

  await service.start();
  assertEquals(service.listSchedules().length, 1);

  const changed = await service.updateTriggerOverrides(new Map());

  assertEquals(changed, 1);
  assertEquals(service.listSchedules().length, 0);

  await service.stop();
});

Deno.test("updateTriggerOverrides: no-op when overrides unchanged", async () => {
  const wf = createTestWorkflow("scheduled-wf", "0 12 * * *");

  const overrides = new Map([
    ["scheduled-wf", { schedule: "0 3 * * *" }],
  ]);

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    triggerOverrides: overrides,
  });

  await service.start();

  const changed = await service.updateTriggerOverrides(
    new Map([["scheduled-wf", { schedule: "0 3 * * *" }]]),
  );

  assertEquals(changed, 0);

  await service.stop();
});

Deno.test("updateTriggerOverrides: inputs-only change is detected", async () => {
  const wf = createTestWorkflow("scheduled-wf", "* * * * * *");
  const capturedInputs: WorkflowRunInput[] = [];

  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: (input, _signal, onEvent) => {
      capturedInputs.push(input);
      onEvent({
        kind: "started",
        runId: "run-1",
        workflowName: wf.name,
        jobs: [],
      });
      onEvent({
        kind: "completed",
        run: {
          id: "run-1",
          workflowId: wf.id,
          workflowName: wf.name,
          status: "succeeded",
          jobs: [],
        },
      });
      return Promise.resolve();
    },
    triggerOverrides: new Map([
      ["scheduled-wf", { inputs: { channel: "#old" } }],
    ]),
  });

  await service.start();

  const changed = await service.updateTriggerOverrides(
    new Map([["scheduled-wf", { inputs: { channel: "#new" } }]]),
  );
  assertEquals(changed, 1);

  await waitFor(
    () => capturedInputs.at(-1)?.inputs?.["channel"] === "#new",
    "fire with updated override inputs",
  );
  await service.stop();

  assertGreater(capturedInputs.length, 0);
  const lastInput = capturedInputs[capturedInputs.length - 1];
  assertEquals(lastInput.inputs, { channel: "#new" });
});

Deno.test("updateTriggerOverrides: override for unknown workflow is skipped", async () => {
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
  });

  await service.start();

  const changed = await service.updateTriggerOverrides(
    new Map([["nonexistent-wf", { schedule: "0 3 * * *" }]]),
  );

  assertEquals(changed, 0);
  assertEquals(service.listSchedules().length, 0);

  await service.stop();
});

Deno.test("ScheduledExecutionService: rescanWorkflows registers new workflows added after start", async () => {
  const wf1 = createTestWorkflow("existing-wf", "0 * * * *");
  const workflows = [wf1];

  const mockRepo = createMockWorkflowRepo(workflows);
  const service = new ScheduledExecutionService({
    workflowRepo: mockRepo,
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
  });

  await service.start();

  let schedules = service.listSchedules();
  assertEquals(schedules.length, 1);
  assertEquals(schedules[0].workflowName, "existing-wf");

  // Simulate a new workflow being added to the repo (e.g., via extension pull + reload)
  const wf2 = createTestWorkflow("new-wf", "30 * * * *");
  workflows.push(wf2);

  await service.rescanWorkflows();

  schedules = service.listSchedules();
  assertEquals(schedules.length, 2);
  const names = schedules.map((s) => s.workflowName).sort();
  assertEquals(names, ["existing-wf", "new-wf"]);

  await service.stop();
});

Deno.test("normalizeFireTime: truncates milliseconds and replaces colons for Windows compat", () => {
  assertEquals(
    normalizeFireTime(new Date("2026-08-01T12:30:45.123Z")),
    "2026-08-01T12-30-45Z",
  );
  assertEquals(
    normalizeFireTime(new Date("2026-08-01T00:00:00.000Z")),
    "2026-08-01T00-00-00Z",
  );
  assertEquals(
    normalizeFireTime(new Date("2026-12-31T23:59:59.999Z")),
    "2026-12-31T23-59-59Z",
  );
});

Deno.test("ScheduledExecutionService: records initiatedBy and emits schedule_started with runId and fireTime", async () => {
  const wf = createTestWorkflow("attributed-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];
  const inputs: WorkflowRunInput[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    initiatedBy: "service:scheduler",
    executeWorkflow: (input, _signal, onEvent) => {
      inputs.push(input);
      onEvent({ kind: "started", runId: "run-1" } as WorkflowRunEvent);
      return Promise.resolve();
    },
  });

  await service.start((e) => events.push(e));
  await waitFor(
    () => events.some((e) => e.kind === "schedule_started"),
    "schedule_started event",
  );
  await service.stop();

  assertEquals(inputs[0].initiatedBy, "service:scheduler");
  const fired = events.find((e) => e.kind === "schedule_fired");
  const started = events.find((e) => e.kind === "schedule_started");
  assertEquals(started?.kind === "schedule_started" && started.runId, "run-1");
  assertEquals(
    started?.kind === "schedule_started" && started.replayed,
    false,
  );
  assertEquals(
    started?.kind === "schedule_started" && fired?.kind === "schedule_fired" &&
      started.fireTime === fired.fireTime,
    true,
  );
});

Deno.test("ScheduledExecutionService: skipped fires carry the fire time", async () => {
  const wf = createTestWorkflow("skip-time-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    cronFireDedup: () => Promise.resolve(false),
  });

  await service.start((e) => events.push(e));
  await waitFor(
    () => events.some((e) => e.kind === "schedule_skipped"),
    "schedule_skipped event",
  );
  await service.stop();

  const skipped = events.find((e) => e.kind === "schedule_skipped");
  assertEquals(
    skipped?.kind === "schedule_skipped" &&
      !Number.isNaN(Date.parse(skipped.fireTime)),
    true,
  );
});

Deno.test("ScheduledExecutionService: a refused run never reaches the executor", async () => {
  const wf = createTestWorkflow("refused-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];
  let executions = 0;
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => {
      executions++;
      return Promise.resolve();
    },
    authorizeRun: (request) =>
      Promise.resolve({
        allowed: false,
        workflowIdOrName: request.workflowName,
        reason: "denied",
      }),
  });

  await service.start((e) => events.push(e));
  await waitFor(
    () => events.some((e) => e.kind === "schedule_denied"),
    "schedule_denied event",
  );
  await service.stop();

  assertEquals(executions, 0);
  const denied = events.find((e) => e.kind === "schedule_denied");
  assertEquals(denied?.kind === "schedule_denied" && denied.reason, "denied");
  assertEquals(
    denied?.kind === "schedule_denied" && typeof denied.fireTime,
    "string",
  );
});

Deno.test("ScheduledExecutionService: replayed runs are authorized and run the authorized workflow", async () => {
  const requests: { workflowName: string; replayed: boolean }[] = [];
  const executed: string[] = [];
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: (input, _signal, onEvent) => {
      executed.push(input.workflowIdOrName);
      onEvent({ kind: "started", runId: "run-r" } as WorkflowRunEvent);
      return Promise.resolve();
    },
    authorizeRun: (request) => {
      requests.push({
        workflowName: request.workflowName,
        replayed: request.replayed,
      });
      return Promise.resolve({
        allowed: true,
        workflowIdOrName: "canonical-wf",
      });
    },
  });

  await service.start((e) => events.push(e));
  service.enqueueForReplay({ pendingRunId: "p-1", workflowIdOrName: "wf-id" });
  await waitFor(() => executed.length === 1, "replayed run executed");
  await service.stop();

  assertEquals(requests, [{ workflowName: "wf-id", replayed: true }]);
  assertEquals(executed, ["canonical-wf"]);
  const started = events.find((e) => e.kind === "schedule_started");
  assertEquals(started?.kind === "schedule_started" && started.replayed, true);
  assertEquals(
    started?.kind === "schedule_started" && started.workflowName,
    "canonical-wf",
  );
  assertEquals(
    started?.kind === "schedule_started" && started.fireTime,
    undefined,
  );
});

Deno.test("ScheduledExecutionService: a throwing authorizer refuses the run and the queue keeps going", async () => {
  const executed: string[] = [];
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: (input) => {
      executed.push(input.workflowIdOrName);
      return Promise.resolve();
    },
    authorizeRun: (request) =>
      request.workflowName === "broken"
        ? Promise.reject(new Error("policy exploded"))
        : Promise.resolve({
          allowed: true,
          workflowIdOrName: request.workflowName,
        }),
  });

  await service.start((e) => events.push(e));
  service.enqueueForReplay({ pendingRunId: "p-1", workflowIdOrName: "broken" });
  service.enqueueForReplay({ pendingRunId: "p-2", workflowIdOrName: "fine" });
  await waitFor(() => executed.length === 1, "second run executed");
  await service.stop();

  assertEquals(executed, ["fine"]);
  const denied = events.find((e) => e.kind === "schedule_denied");
  assertEquals(
    denied?.kind === "schedule_denied" &&
      denied.reason.includes("policy exploded"),
    true,
  );
});

Deno.test("ScheduledExecutionService: a nested workflow's started event does not retarget the run (swamp-club#2470)", async () => {
  const wf = createTestWorkflow("nested-started-wf", "* * * * * *");
  const events: ScheduledExecutionEvent[] = [];
  let aborted = false;
  const service = new ScheduledExecutionService({
    workflowRepo: createMockWorkflowRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: (_input, signal, onEvent) => {
      onEvent({ kind: "started", runId: "parent-1" } as WorkflowRunEvent);
      onEvent(
        {
          kind: "started",
          runId: "child-1",
          parentRunId: "parent-1",
        } as WorkflowRunEvent,
      );
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
    },
  });

  await service.start((e) => events.push(e));
  await waitFor(
    () => events.some((e) => e.kind === "schedule_started"),
    "schedule_started event",
  );

  assertEquals(service.cancelByRunId("child-1"), false);
  assertEquals(service.cancelByRunId("parent-1"), true);
  await waitFor(() => aborted, "the parent run to be aborted");
  await service.stop();

  const started = events.filter((e) => e.kind === "schedule_started");
  assertEquals(started.length, 1);
  assertEquals(
    started[0].kind === "schedule_started" && started[0].runId,
    "parent-1",
  );
});

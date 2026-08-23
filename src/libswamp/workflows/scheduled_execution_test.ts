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

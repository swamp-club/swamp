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

import { assert, assertEquals } from "@std/assert";
import { Cron } from "croner";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  type ScheduledExecutionEvent,
  ScheduledExecutionService,
  type WorkflowExecutor,
} from "./scheduled_execution.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import {
  CATCH_UP_TAG,
  type ScheduleCatchUp,
  SCHEDULED_FOR_TAG,
} from "../../domain/workflows/schedule_catch_up.ts";
import type {
  ScheduleState,
  ScheduleStateRepository,
} from "../../domain/workflows/schedule_state.ts";
import type {
  SchedulePause,
  SchedulePauseRepository,
} from "../../domain/workflows/schedule_pause.ts";
import type { WorkflowRunInput } from "./run.ts";

// a monthly slot never fires during a test, so only the catch-up pass runs it
const MONTHLY = "0 9 1 * *";

/** two consecutive slots, computed in the process zone as croner does */
function slots(): { previous: Date; missed: Date } {
  const cron = new Cron(MONTHLY);
  const previous = cron.nextRun(new Date("2026-06-15T00:00:00Z"))!;
  const missed = cron.nextRun(previous)!;
  return { previous, missed };
}

const HOUR = 60 * 60 * 1000;

function createWorkflow(
  name: string,
  schedule: string,
  catchUp?: ScheduleCatchUp,
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
    trigger: { schedule, ...(catchUp ? { catchUp } : {}) },
    jobs: [job],
  });
}

function createRepo(workflows: Workflow[]): WorkflowRepository {
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

class MemoryStateRepo implements ScheduleStateRepository {
  readonly states = new Map<string, ScheduleState>();
  saves = 0;
  failSaves = false;
  canWrite = true;

  get(workflowId: WorkflowId): Promise<ScheduleState | null> {
    return Promise.resolve(this.states.get(workflowId) ?? null);
  }

  list(): Promise<ScheduleState[]> {
    return Promise.resolve([...this.states.values()]);
  }

  save(state: ScheduleState): Promise<boolean> {
    if (this.failSaves) return Promise.reject(new Error("store down"));
    if (!this.canWrite) return Promise.resolve(false);
    this.saves++;
    this.states.set(state.workflowId, state);
    return Promise.resolve(true);
  }

  watermark(workflowId: string): string | undefined {
    return this.states.get(workflowId)?.lastEvaluatedFireTime;
  }
}

function pausesOf(pauses: SchedulePause[]): SchedulePauseRepository {
  return {
    get: (id) =>
      Promise.resolve(pauses.find((p) => p.workflowId === id) ?? null),
    list: () => Promise.resolve(pauses),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
}

function recordingExecutor(): {
  executeWorkflow: WorkflowExecutor;
  inputs: WorkflowRunInput[];
} {
  const inputs: WorkflowRunInput[] = [];
  return {
    inputs,
    executeWorkflow: (input, _signal, onEvent) => {
      inputs.push(input);
      onEvent({
        kind: "started",
        runId: `run-${inputs.length}`,
        workflowName: input.workflowIdOrName,
        jobs: [],
      });
      return Promise.resolve();
    },
  };
}

function seed(
  repo: MemoryStateRepo,
  workflow: Workflow,
  watermark: Date,
): void {
  repo.states.set(workflow.id, {
    workflowId: workflow.id,
    workflowName: workflow.name,
    lastEvaluatedFireTime: watermark.toISOString(),
    cronExpression: workflow.schedule,
  });
}

function missedEvents(events: ScheduledExecutionEvent[]) {
  return events.filter((e) => e.kind === "schedule_missed");
}

Deno.test("catchUpMissedFires: with no recorded state seeds the watermark at now and fires nothing", async () => {
  const wf = createWorkflow("seed-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  const executor = recordingExecutor();
  const now = new Date("2026-08-01T12:00:00Z");
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    now: () => now.getTime(),
  });

  await service.start((e) => events.push(e));
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(states.watermark(wf.id), now.toISOString());
  assertEquals(executor.inputs.length, 0);
  assertEquals(missedEvents(events), []);
});

Deno.test("catchUpMissedFires: fires the missed slot once within maxDelay, tagged as a catch-up", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("catch-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const executor = recordingExecutor();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    now: () => missed.getTime() + HOUR,
  });

  await service.start((e) => events.push(e));
  await service.catchUpMissedFires();
  await waitFor(() => executor.inputs.length === 1, "catch-up run");
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(executor.inputs.length, 1);
  assertEquals(executor.inputs[0].runtimeTags, {
    [CATCH_UP_TAG]: "true",
    [SCHEDULED_FOR_TAG]: missed.toISOString(),
  });
  assertEquals(states.watermark(wf.id), missed.toISOString());
  const recorded = states.states.get(wf.id)?.lastMissed;
  assertEquals(recorded?.reason, "serve_down");
  assertEquals(recorded?.caughtUp, true);
  assertEquals(recorded?.fireTime, missed.toISOString());
  const missedEvent = missedEvents(events);
  assertEquals(missedEvent.length, 1);
  assertEquals(
    missedEvent[0].kind === "schedule_missed" && missedEvent[0].caughtUp,
    true,
  );
  const fired = events.find((e) => e.kind === "schedule_fired");
  assertEquals(fired?.kind === "schedule_fired" && fired.catchUp, true);
  const started = events.find((e) => e.kind === "schedule_started");
  assertEquals(started?.kind === "schedule_started" && started.catchUp, true);
});

Deno.test("catchUpMissedFires: a slot older than maxDelay is recorded as missed but not fired", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("stale-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const executor = recordingExecutor();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    now: () => missed.getTime() + 48 * HOUR,
  });

  await service.start((e) => events.push(e));
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(executor.inputs.length, 0);
  assertEquals(states.watermark(wf.id), missed.toISOString());
  const recorded = states.states.get(wf.id)?.lastMissed;
  assertEquals(recorded?.caughtUp, false);
  assertEquals(recorded?.count, 1);
  assertEquals(service.scheduleStatus(wf.id).lastMissed, recorded);
  const missedEvent = missedEvents(events);
  assertEquals(missedEvent.length, 1);
  assertEquals(
    missedEvent[0].kind === "schedule_missed" && missedEvent[0].caughtUp,
    false,
  );
});

Deno.test("catchUpMissedFires: without a catch-up policy records the miss and fires nothing", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("plain-wf", MONTHLY);
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const executor = recordingExecutor();
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    now: () => missed.getTime() + 60_000,
  });

  await service.start();
  await service.catchUpMissedFires();
  assertEquals(service.scheduleStatus(wf.id).catchUp, null);
  await service.stop();

  assertEquals(executor.inputs.length, 0);
  assertEquals(states.states.get(wf.id)?.lastMissed?.reason, "serve_down");
});

Deno.test("catchUpMissedFires: a serve.yaml override supplies the catch-up policy", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("override-wf", MONTHLY);
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const executor = recordingExecutor();
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    triggerOverrides: new Map([["override-wf", {
      catchUp: { policy: "latest", maxDelay: "1d" },
    }]]),
    now: () => missed.getTime() + HOUR,
  });

  await service.start();
  await service.catchUpMissedFires();
  await waitFor(() => executor.inputs.length === 1, "catch-up run");
  assertEquals(service.scheduleStatus(wf.id).catchUp, {
    policy: "latest",
    maxDelay: "1d",
  });
  await service.stop();

  assertEquals(executor.inputs.length, 1);
});

Deno.test("catchUpMissedFires: a schedule paused at the missed slot is not caught up", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("paused-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const executor = recordingExecutor();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    schedulePauses: pausesOf([{
      workflowId: wf.id,
      workflowName: wf.name,
      pausedBy: "tester",
      pausedAt: previous.toISOString(),
    }]),
    now: () => missed.getTime() + HOUR,
  });

  await service.start((e) => events.push(e));
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(executor.inputs.length, 0);
  assertEquals(states.watermark(wf.id), missed.toISOString());
  assertEquals(states.states.get(wf.id)?.lastMissed?.caughtUp, false);
  assertEquals(
    states.states.get(wf.id)?.lastMissed?.reason,
    "serve_down",
  );
  assert(events.some((e) => e.kind === "schedule_skipped" && e.paused));
});

Deno.test("catchUpMissedFires: a slot claimed by another instance is left to it", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("dedup-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const executor = recordingExecutor();
  const claims: string[] = [];
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    cronFireDedup: (_id, fireTime) => {
      claims.push(fireTime.toISOString());
      return Promise.resolve(false);
    },
    now: () => missed.getTime() + HOUR,
  });

  await service.start((e) => events.push(e));
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(missedEvents(events), []);
  assertEquals(claims, [missed.toISOString()]);
  assertEquals(executor.inputs.length, 0);
  assertEquals(states.watermark(wf.id), previous.toISOString());
});

Deno.test("catchUpMissedFires: a store that cannot save still lets the catch-up run", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("flaky-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  states.failSaves = true;
  const executor = recordingExecutor();
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    now: () => missed.getTime() + HOUR,
  });

  await service.start();
  await service.catchUpMissedFires();
  await waitFor(() => executor.inputs.length === 1, "catch-up run");
  await service.stop();

  assertEquals(executor.inputs.length, 1);
});

Deno.test("ScheduledExecutionService: boot registration keeps watermarks; a schedule added after start resets its own", async () => {
  const { previous } = slots();
  const existing = createWorkflow("existing-wf", MONTHLY);
  const added = createWorkflow("added-wf", MONTHLY);
  const workflows = [existing];
  const states = new MemoryStateRepo();
  seed(states, existing, previous);
  seed(states, added, previous);
  const now = new Date("2026-09-20T00:00:00Z");
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo(workflows),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    scheduleState: states,
    now: () => now.getTime(),
  });

  await service.start();
  assertEquals(states.saves, 0);

  workflows.push(added);
  await service.rescanWorkflows();
  await waitFor(
    () => states.watermark(added.id) === now.toISOString(),
    "added schedule watermark reset",
  );
  await service.stop();

  assertEquals(states.watermark(existing.id), previous.toISOString());
});

Deno.test("ScheduledExecutionService: changing a schedule's expression after start resets its watermark", async () => {
  const { previous } = slots();
  const wf = createWorkflow("changed-wf", MONTHLY);
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const now = new Date("2026-09-20T00:00:00Z");
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    scheduleState: states,
    now: () => now.getTime(),
  });

  await service.start();
  await service.rescanWorkflows();
  assertEquals(states.watermark(wf.id), previous.toISOString());

  await service.updateTriggerOverrides(
    new Map([["changed-wf", { schedule: "0 9 2 * *" }]]),
  );
  await waitFor(
    () => states.watermark(wf.id) === now.toISOString(),
    "watermark reset on expression change",
  );
  await service.stop();
});

Deno.test("ScheduledExecutionService: a fire records its slot as the watermark", async () => {
  const wf = createWorkflow("tick-wf", "* * * * * *");
  const states = new MemoryStateRepo();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    scheduleState: states,
  });

  await service.start((e) => events.push(e));
  await waitFor(
    () => events.some((e) => e.kind === "schedule_fired"),
    "a fire",
  );
  await service.stop();

  const fired = events.find((e) => e.kind === "schedule_fired");
  assert(fired?.kind === "schedule_fired");
  const watermark = states.watermark(wf.id);
  assert(watermark !== undefined);
  assert(Date.parse(watermark) >= Date.parse(fired.fireTime));
});

Deno.test("ScheduledExecutionService: a fire claimed while draining is settled before it is recorded for replay", async () => {
  const wf = createWorkflow("drain-wf", "* * * * * *");
  const states = new MemoryStateRepo();
  const dedupGate = Promise.withResolvers<boolean>();
  const claimed: string[] = [];
  const replayed: string[] = [];
  let executions = 0;
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => {
      executions++;
      return Promise.resolve();
    },
    scheduleState: states,
    cronFireDedup: (_id, fireTime) => {
      claimed.push(fireTime.toISOString());
      return dedupGate.promise;
    },
    pendingRunHook: {
      enqueue: (entry) => {
        replayed.push(entry.workflowIdOrName);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    },
  });

  await service.start();
  await waitFor(() => claimed.length > 0, "fire reached dedup");
  const drain = service.drain(0);
  dedupGate.resolve(true);
  await drain;
  await service.stop();

  assertEquals(executions, 0);
  assert(replayed.length > 0);
  const watermark = states.watermark(wf.id);
  assert(watermark !== undefined);
  assert(Date.parse(watermark) >= Date.parse(claimed[0]));
});

Deno.test("ScheduledExecutionService: an overlap skip is recorded as a missed fire", async () => {
  const wf = createWorkflow("overlap-wf", "* * * * * *");
  const states = new MemoryStateRepo();
  const gate = Promise.withResolvers<void>();
  const events: ScheduledExecutionEvent[] = [];
  let runs = 0;
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: (input, signal, onEvent) => {
      runs++;
      onEvent({
        kind: "started",
        runId: `run-${runs}`,
        workflowName: input.workflowIdOrName,
        jobs: [],
      });
      return new Promise<void>((resolve) => {
        gate.promise.then(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    scheduleState: states,
  });

  await service.start((e) => events.push(e));
  await waitFor(
    () => states.states.get(wf.id)?.lastMissed?.reason === "overlap",
    "overlap recorded",
  );
  gate.resolve();
  await service.stop();

  assert(events.some((e) =>
    e.kind === "schedule_skipped" &&
    e.reason === "Previous run still in progress"
  ));
});

Deno.test("catchUpMissedFires: a promoted follower measures from the stored watermark, not the one it booted with", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("promoted-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "1d",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  states.canWrite = false;
  const executor = recordingExecutor();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    now: () => missed.getTime() + 5 * HOUR,
  });

  await service.start((e) => events.push(e));
  // the leader fires the slot after this node booted, then dies
  seed(states, wf, missed);
  states.canWrite = true;
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(executor.inputs.length, 0);
  assertEquals(missedEvents(events), []);
  assertEquals(states.states.get(wf.id)?.lastMissed, undefined);
});

Deno.test("catchUpMissedFires: a run recording a slot newer than the watermark settles it", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("history-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "1d",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const executor = recordingExecutor();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    latestScheduledSlot: () => Promise.resolve(missed),
    now: () => missed.getTime() + 5 * HOUR,
  });

  await service.start((e) => events.push(e));
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(executor.inputs.length, 0);
  assertEquals(missedEvents(events), []);
});

Deno.test("catchUpMissedFires: a run-history lookup that fails falls back to the watermark", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("history-down-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const executor = recordingExecutor();
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    latestScheduledSlot: () => Promise.reject(new Error("runs unreadable")),
    now: () => missed.getTime() + HOUR,
  });

  await service.start();
  await service.catchUpMissedFires();
  await waitFor(() => executor.inputs.length === 1, "catch-up run");
  await service.stop();
});

Deno.test("catchUpMissedFires: a slot fired here before the pass is not missed, only the gap before it, and nothing is caught up", async () => {
  const wf = createWorkflow("gap-wf", "* * * * * *", {
    policy: "latest",
    maxDelay: "1h",
  });
  const states = new MemoryStateRepo();
  const seeded = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
  seed(states, wf, seeded);
  const executor = recordingExecutor();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
  });

  await service.start((e) => events.push(e));
  await waitFor(
    () => events.some((e) => e.kind === "schedule_fired"),
    "a fire before the pass",
  );
  const firstFired = events.find((e) => e.kind === "schedule_fired");
  assert(firstFired?.kind === "schedule_fired");
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(
    executor.inputs.filter((i) => i.runtimeTags?.[CATCH_UP_TAG]).length,
    0,
  );
  const missed = missedEvents(events);
  assertEquals(missed.length, 1);
  assert(missed[0].kind === "schedule_missed");
  assert(Date.parse(missed[0].fireTime) < Date.parse(firstFired.fireTime));
  assert(Date.parse(missed[0].oldestFireTime) > seeded.getTime());
  assertEquals(missed[0].caughtUp, false);
});

Deno.test("catchUpMissedFires: a run without a newer recorded slot, such as a replayed one, does not hide the miss", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("replayed-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const executor = recordingExecutor();
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    latestScheduledSlot: () => Promise.resolve(previous),
    now: () => missed.getTime() + HOUR,
  });

  await service.start();
  await service.catchUpMissedFires();
  await waitFor(() => executor.inputs.length === 1, "catch-up run");
  await service.stop();
});

Deno.test("catchUpMissedFires: a watermark measured on another expression starts afresh", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("edited-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  states.states.set(wf.id, {
    workflowId: wf.id,
    workflowName: wf.name,
    lastEvaluatedFireTime: previous.toISOString(),
    cronExpression: "0 9 2 * *",
  });
  const now = new Date(missed.getTime() + HOUR);
  const executor = recordingExecutor();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    now: () => now.getTime(),
  });

  await service.start((e) => events.push(e));
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(executor.inputs.length, 0);
  assertEquals(missedEvents(events), []);
  assertEquals(states.watermark(wf.id), now.toISOString());
  assertEquals(states.states.get(wf.id)?.cronExpression, MONTHLY);
});

Deno.test("catchUpMissedFires: a slot fired before the pass whose state write failed is not fired again", async () => {
  const wf = createWorkflow("unrecorded-wf", "* * * * * *", {
    policy: "latest",
    maxDelay: "1h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000));
  states.failSaves = true;
  const executor = recordingExecutor();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
  });

  await service.start((e) => events.push(e));
  await waitFor(
    () => events.some((e) => e.kind === "schedule_fired"),
    "a fire before the pass",
  );
  states.failSaves = false;
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(
    executor.inputs.filter((i) => i.runtimeTags?.[CATCH_UP_TAG]).length,
    0,
  );
});

Deno.test("ScheduledExecutionService: every cron-fired run records its slot", async () => {
  const wf = createWorkflow("slot-tag-wf", "* * * * * *");
  const executor = recordingExecutor();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
  });

  await service.start((e) => events.push(e));
  await waitFor(() => executor.inputs.length > 0, "a cron-fired run");
  await service.stop();

  const fired = events.find((e) => e.kind === "schedule_fired");
  assert(fired?.kind === "schedule_fired");
  assertEquals(executor.inputs[0].runtimeTags, {
    [SCHEDULED_FOR_TAG]: fired.fireTime,
  });
});

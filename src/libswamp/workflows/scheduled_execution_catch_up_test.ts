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
  failGets = false;
  canWrite = true;

  get(workflowId: WorkflowId): Promise<ScheduleState | null> {
    if (this.failGets) return Promise.reject(new Error("store unreadable"));
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
      schedule: MONTHLY,
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
  states.states.set(wf.id, {
    ...states.states.get(wf.id)!,
    lastMissed: {
      fireTime: previous.toISOString(),
      count: 2,
      reason: "paused",
      caughtUp: false,
      detectedAt: previous.toISOString(),
    },
  });
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
  assertEquals(states.states.get(wf.id)?.lastMissed, undefined);
  assertEquals(service.scheduleStatus(wf.id).lastMissed, null);
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

Deno.test("catchUpMissedFires: a nickname schedule is measured on the expression as written", async () => {
  const cron = new Cron("@monthly");
  const previous = cron.nextRun(new Date("2026-06-15T00:00:00Z"))!;
  const missed = cron.nextRun(previous)!;
  const wf = createWorkflow("nickname-wf", "@monthly", {
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
    now: () => missed.getTime() + HOUR,
  });

  await service.start();
  await service.catchUpMissedFires();
  await waitFor(() => executor.inputs.length === 1, "catch-up run");
  await service.stop();

  assertEquals(
    executor.inputs[0].runtimeTags?.[SCHEDULED_FOR_TAG],
    missed.toISOString(),
  );
});

Deno.test("catchUpMissedFires: a recorded slot after now settles nothing", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("future-tag-wf", MONTHLY, {
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
    latestScheduledSlot: () =>
      Promise.resolve(new Date("2099-01-01T00:00:00Z")),
    now: () => missed.getTime() + HOUR,
  });

  await service.start();
  await service.catchUpMissedFires();
  await waitFor(() => executor.inputs.length === 1, "catch-up run");
  await service.stop();
});

Deno.test("catchUpMissedFires: an instance that may not write reports no miss", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("silent-wf", MONTHLY);
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  states.canWrite = false;
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    scheduleState: states,
    now: () => missed.getTime() + HOUR,
  });

  await service.start((e) => events.push(e));
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(missedEvents(events), []);
});

Deno.test("updateTriggerOverrides: a change to catchUp alone is counted", async () => {
  const wf = createWorkflow("catch-only-wf", MONTHLY);
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    triggerOverrides: new Map([["catch-only-wf", { schedule: MONTHLY }]]),
  });

  await service.start();
  const changed = await service.updateTriggerOverrides(
    new Map([["catch-only-wf", {
      schedule: MONTHLY,
      catchUp: { policy: "latest", maxDelay: "6h" },
    }]]),
  );
  assertEquals(service.scheduleStatus(wf.id).catchUp, {
    policy: "latest",
    maxDelay: "6h",
  });
  await service.stop();

  assertEquals(changed, 1);
});

Deno.test("catchUpMissedFires: a tick that begins while the pass reads run history is not caught up again", async () => {
  const wf = createWorkflow("racing-wf", "* * * * * *", {
    policy: "latest",
    maxDelay: "1h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000));
  const executor = recordingExecutor();
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    latestScheduledSlot: async () => {
      await waitFor(
        () => events.some((e) => e.kind === "schedule_fired"),
        "a tick during the pass",
      );
      return null;
    },
  });

  await service.start((e) => events.push(e));
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(
    executor.inputs.filter((i) => i.runtimeTags?.[CATCH_UP_TAG]).length,
    0,
  );
});

Deno.test("ScheduledExecutionService: a fire whose state cannot be re-read still runs and overwrites nothing", async () => {
  const wf = createWorkflow("unread-wf", "* * * * * *");
  const states = new MemoryStateRepo();
  const later = new Date("2099-01-01T00:00:00.000Z");
  seed(states, wf, later);
  const executor = recordingExecutor();
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
  });

  await service.start();
  states.failGets = true;
  await waitFor(() => executor.inputs.length > 0, "a fire");
  await service.stop();

  assertEquals(states.saves, 0);
  assertEquals(states.watermark(wf.id), later.toISOString());
});

Deno.test("catchUpMissedFires: a miss nothing will catch up never reads run history", async () => {
  const { previous, missed } = slots();
  for (
    const catchUp of [
      undefined,
      { policy: "none" } as const,
      { policy: "latest", maxDelay: "1h" } as const,
    ]
  ) {
    const wf = createWorkflow("no-history-wf", MONTHLY, catchUp);
    const states = new MemoryStateRepo();
    seed(states, wf, previous);
    let lookups = 0;
    const service = new ScheduledExecutionService({
      workflowRepo: createRepo([wf]),
      repoDir: "/tmp/nonexistent-test-repo",
      executeWorkflow: () => Promise.resolve(),
      scheduleState: states,
      latestScheduledSlot: () => {
        lookups++;
        return Promise.resolve(null);
      },
      now: () => missed.getTime() + 5 * HOUR,
    });

    await service.start();
    await service.catchUpMissedFires();
    await service.stop();

    assertEquals(lookups, 0);
    assertEquals(states.states.get(wf.id)?.lastMissed?.reason, "serve_down");
  }
});

Deno.test("catchUpMissedFires: a miss to catch up reads run history under a live signal", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("signal-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  const signals: AbortSignal[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    scheduleState: states,
    latestScheduledSlot: (_id, signal) => {
      signals.push(signal);
      return Promise.resolve(missed);
    },
    now: () => missed.getTime() + HOUR,
  });

  await service.start();
  await service.catchUpMissedFires();
  await service.stop();

  assertEquals(signals.length, 1);
  assertEquals(signals[0].aborted, false);
});

Deno.test("catchUpMissedFires: every schedule shares one run-history budget, and once spent the watermark decides", async () => {
  const { previous, missed } = slots();
  const catchUp = { policy: "latest", maxDelay: "6h" } as const;
  const first = createWorkflow("budget-a", MONTHLY, catchUp);
  const second = createWorkflow("budget-b", MONTHLY, catchUp);
  const states = new MemoryStateRepo();
  seed(states, first, previous);
  seed(states, second, previous);
  const executor = recordingExecutor();
  let lookups = 0;
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([first, second]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    maxConcurrentRuns: 2,
    runHistoryTimeoutMs: 1,
    latestScheduledSlot: (_id, signal) => {
      lookups++;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      );
    },
    now: () => missed.getTime() + HOUR,
  });

  await service.start();
  await service.catchUpMissedFires();
  await waitFor(() => executor.inputs.length === 2, "both catch-up runs");
  await service.stop();

  assertEquals(lookups, 1);
  assertEquals(states.states.get(first.id)?.lastMissed?.caughtUp, true);
  assertEquals(states.states.get(second.id)?.lastMissed?.caughtUp, true);
});

Deno.test("catchUpMissedFires: stopping aborts a run-history read in progress", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("stop-read-wf", MONTHLY, {
    policy: "latest",
    maxDelay: "6h",
  });
  const states = new MemoryStateRepo();
  seed(states, wf, previous);
  let reading = false;
  let aborted = false;
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    scheduleState: states,
    latestScheduledSlot: (_id, signal) => {
      reading = true;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true })
      );
    },
    now: () => missed.getTime() + HOUR,
  });

  await service.start();
  const pass = service.catchUpMissedFires();
  await waitFor(() => reading, "the history read to start");
  await service.stop();
  await pass;

  assertEquals(aborted, true);
});

Deno.test("ScheduledExecutionService: paused fires in a row add up, and the first fire after resume clears them", async () => {
  const wf = createWorkflow("resume-wf", "* * * * * *");
  const states = new MemoryStateRepo();
  const pauses: SchedulePause[] = [{
    workflowId: wf.id,
    workflowName: wf.name,
    pausedBy: "tester",
    pausedAt: new Date().toISOString(),
  }];
  const events: ScheduledExecutionEvent[] = [];
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    scheduleState: states,
    schedulePauses: pausesOf(pauses),
  });

  await service.start((e) => events.push(e));
  await waitFor(
    () => (states.states.get(wf.id)?.lastMissed?.count ?? 0) >= 2,
    "two paused fires recorded",
  );
  assertEquals(states.states.get(wf.id)?.lastMissed?.reason, "paused");
  pauses.length = 0;
  await waitFor(
    () => events.some((e) => e.kind === "schedule_fired"),
    "a fire after resume",
  );
  await waitFor(
    () => states.states.get(wf.id)?.lastMissed === undefined,
    "the paused miss cleared",
  );
  await service.stop();

  assertEquals(service.scheduleStatus(wf.id).lastMissed, null);
});

/** holds the next get or save open until release, once */
class GatedStateRepo extends MemoryStateRepo {
  readonly gets: string[] = [];
  held = false;
  /** reads that began while a save was still in flight */
  readsDuringSave = 0;
  #saving = 0;
  #kind: "get" | "save" | null = null;
  #gate = Promise.withResolvers<void>();

  holdNext(kind: "get" | "save"): void {
    this.#kind = kind;
  }

  release(): void {
    this.#gate.resolve();
  }

  override async get(workflowId: WorkflowId): Promise<ScheduleState | null> {
    this.gets.push(workflowId);
    if (this.#saving > 0) this.readsDuringSave++;
    await this.#wait("get");
    return await super.get(workflowId);
  }

  override async save(state: ScheduleState): Promise<boolean> {
    this.#saving++;
    try {
      await this.#wait("save");
      return await super.save(state);
    } finally {
      this.#saving--;
    }
  }

  async #wait(kind: "get" | "save"): Promise<void> {
    if (this.#kind !== kind) return;
    this.#kind = null;
    this.held = true;
    await this.#gate.promise;
  }
}

Deno.test("ScheduledExecutionService: a state write waits for the one before it, so a late save never moves the watermark back", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("serial-wf", MONTHLY);
  const states = new GatedStateRepo();
  seed(states, wf, previous);
  const now = missed.getTime() + HOUR;
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    scheduleState: states,
    now: () => now,
  });

  await service.start();
  states.holdNext("save");
  const pass = service.catchUpMissedFires();
  await waitFor(() => states.held, "the missed fire's save to start");
  // resets the watermark to now while the older save is still held
  await service.updateTriggerOverrides(
    new Map([["serial-wf", { schedule: "0 9 2 * *" }]]),
  );
  states.release();
  await pass;
  await service.stop();

  assertEquals(states.readsDuringSave, 0);
  assertEquals(states.watermark(wf.id), new Date(now).toISOString());
  assertEquals(states.states.get(wf.id)?.cronExpression, "0 9 2 * *");
});

Deno.test("catchUpMissedFires: shutdown ends the pass, so no further schedule is read and nothing is fired", async () => {
  const { previous, missed } = slots();
  const catchUp = { policy: "latest", maxDelay: "6h" } as const;
  const first = createWorkflow("shutdown-a", MONTHLY, catchUp);
  const second = createWorkflow("shutdown-b", MONTHLY, catchUp);
  const states = new GatedStateRepo();
  seed(states, first, previous);
  seed(states, second, previous);
  const executor = recordingExecutor();
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([first, second]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: executor.executeWorkflow,
    scheduleState: states,
    maxConcurrentRuns: 2,
    now: () => missed.getTime() + HOUR,
  });

  await service.start();
  states.holdNext("get");
  const pass = service.catchUpMissedFires();
  await waitFor(() => states.held, "the first schedule's state read");
  const stopping = service.stop();
  states.release();
  await Promise.all([pass, stopping]);

  assertEquals(states.gets.length, 1);
  assertEquals(executor.inputs.length, 0);
});

Deno.test("ScheduledExecutionService: writes requested while one is held fold into a single next write", async () => {
  const { previous, missed } = slots();
  const wf = createWorkflow("coalesce-wf", MONTHLY);
  const states = new GatedStateRepo();
  seed(states, wf, previous);
  const now = missed.getTime() + HOUR;
  const service = new ScheduledExecutionService({
    workflowRepo: createRepo([wf]),
    repoDir: "/tmp/nonexistent-test-repo",
    executeWorkflow: () => Promise.resolve(),
    scheduleState: states,
    now: () => now,
  });

  await service.start();
  states.holdNext("save");
  const pass = service.catchUpMissedFires();
  await waitFor(() => states.held, "the missed fire's save to start");
  for (const schedule of ["0 9 2 * *", "0 9 3 * *", "0 9 4 * *"]) {
    await service.updateTriggerOverrides(
      new Map([["coalesce-wf", { schedule }]]),
    );
  }
  states.release();
  await pass;
  await service.stop();

  assertEquals(states.saves, 2);
  assertEquals(states.readsDuringSave, 0);
  assertEquals(states.watermark(wf.id), new Date(now).toISOString());
  assertEquals(states.states.get(wf.id)?.cronExpression, "0 9 4 * *");
});

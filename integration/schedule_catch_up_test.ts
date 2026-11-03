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
import { Cron } from "croner";
import { waitFor } from "@swamp-club/swamp-testing";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { WorkflowRepository } from "../src/domain/workflows/repositories.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { ControlPlaneScheduleStateRepository } from "../src/infrastructure/persistence/control_plane_schedule_state_repository.ts";
import {
  normalizeFireTime,
  ScheduledExecutionService,
  type WorkflowExecutor,
} from "../src/libswamp/workflows/scheduled_execution.ts";
import type { WorkflowRunInput } from "../src/libswamp/workflows/run.ts";
import { CATCH_UP_TAG } from "../src/domain/workflows/schedule_catch_up.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const MONTHLY = "0 9 1 * *";
const HOUR = 60 * 60 * 1000;

/** two consecutive slots in the process zone, as croner computes them */
function slots(): { previous: Date; missed: Date } {
  const cron = new Cron(MONTHLY);
  const previous = cron.nextRun(new Date("2026-06-15T00:00:00Z"))!;
  return { previous, missed: cron.nextRun(previous)! };
}

interface Fixture {
  repoDir: string;
  workflowRepo: WorkflowRepository;
  workflow: Workflow;
  store: FileSystemControlPlaneStore;
  runs: WorkflowRunInput[];
  /** a serve instance over the shared repo and control plane */
  instance: (
    now: number,
    options?: { canWrite?: () => boolean },
  ) => ScheduledExecutionService;
}

async function withCatchUpRepo(
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-catch-up-" });
  const services: ScheduledExecutionService[] = [];
  try {
    const version = "20260101.120000.0";
    const initEvents = await collect(
      repoInit(createLibSwampContext(), createRepoInitDeps(version), {
        path: repoDir,
        force: false,
        version,
        tools: [],
      }),
    );
    assertEquals(initEvents.some((event) => event.kind === "error"), false);
    const { workflowRepo } = createRepositoryContext({ repoDir });
    const workflow = Workflow.create({
      name: "monthly-maintenance",
      trigger: {
        schedule: MONTHLY,
        catchUp: { policy: "latest", maxDelay: "6h" },
      },
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "noop",
          task: StepTask.model("echo", "run", {}),
        })],
      })],
    });
    await workflowRepo.save(workflow);

    const store = new FileSystemControlPlaneStore(repoDir);
    const runs: WorkflowRunInput[] = [];
    const executeWorkflow: WorkflowExecutor = (input, _signal, onEvent) => {
      runs.push(input);
      onEvent({
        kind: "started",
        runId: crypto.randomUUID(),
        workflowName: input.workflowIdOrName,
        jobs: [],
      });
      return Promise.resolve();
    };
    const instance = (
      now: number,
      options?: { canWrite?: () => boolean },
    ): ScheduledExecutionService => {
      const service = new ScheduledExecutionService({
        workflowRepo,
        repoDir,
        executeWorkflow,
        scheduleState: new ControlPlaneScheduleStateRepository(store, {
          canWrite: options?.canWrite,
        }),
        // the same claim serve makes, so instances sharing the store dedup
        cronFireDedup: (workflowId, fireTime) =>
          store.putIfAbsent(
            `fire-records/${workflowId}/${normalizeFireTime(fireTime)}`,
            new TextEncoder().encode("{}"),
          ),
        now: () => now,
      });
      services.push(service);
      return service;
    };
    await fn({ repoDir, workflowRepo, workflow, store, runs, instance });
  } finally {
    for (const service of services) await service.stop();
    await Deno.remove(repoDir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

Deno.test("schedule catch-up: restarts catch up a missed monthly fire exactly once", async () => {
  await withCatchUpRepo(async ({ workflow, store, runs, instance }) => {
    const { previous, missed } = slots();

    const first = instance(previous.getTime() + 60_000);
    await first.start();
    await first.catchUpMissedFires();
    await first.stop();
    assertEquals(runs.length, 0);

    const second = instance(missed.getTime() + HOUR);
    await second.start();
    await second.catchUpMissedFires();
    await waitFor(() => runs.length === 1, "catch-up run");
    await second.stop();
    assertEquals(runs[0].runtimeTags?.[CATCH_UP_TAG], "true");

    const third = instance(missed.getTime() + 2 * HOUR);
    await third.start();
    await third.catchUpMissedFires();
    await third.stop();
    assertEquals(runs.length, 1);

    const states = await new ControlPlaneScheduleStateRepository(store)
      .list();
    assertEquals(states.length, 1);
    assertEquals(states[0].workflowId, workflow.id);
    assertEquals(states[0].lastEvaluatedFireTime, missed.toISOString());
    assertEquals(states[0].lastMissed?.caughtUp, true);
  });
});

Deno.test("schedule catch-up: two instances booting together run the catch-up once", async () => {
  await withCatchUpRepo(async ({ workflow, store, runs, instance }) => {
    const { previous, missed } = slots();
    await new ControlPlaneScheduleStateRepository(store).save({
      workflowId: workflow.id,
      workflowName: workflow.name,
      lastEvaluatedFireTime: previous.toISOString(),
      cronExpression: MONTHLY,
    });

    const a = instance(missed.getTime() + HOUR);
    const b = instance(missed.getTime() + HOUR);
    await Promise.all([a.start(), b.start()]);
    await Promise.all([a.catchUpMissedFires(), b.catchUpMissedFires()]);
    await waitFor(() => runs.length >= 1, "catch-up run");
    await Promise.all([a.stop(), b.stop()]);

    assertEquals(runs.length, 1);
  });
});

Deno.test("schedule catch-up: a fire older than maxDelay is recorded for every reader without running", async () => {
  await withCatchUpRepo(async ({ workflow, store, runs, instance }) => {
    const { previous, missed } = slots();
    await new ControlPlaneScheduleStateRepository(store).save({
      workflowId: workflow.id,
      workflowName: workflow.name,
      lastEvaluatedFireTime: previous.toISOString(),
      cronExpression: MONTHLY,
    });

    const service = instance(missed.getTime() + 3 * 24 * HOUR);
    await service.start();
    await service.catchUpMissedFires();
    await service.stop();

    assertEquals(runs.length, 0);
    const [state] = await new ControlPlaneScheduleStateRepository(store)
      .list();
    assertEquals(state.lastMissed?.reason, "serve_down");
    assertEquals(state.lastMissed?.caughtUp, false);
    assertEquals(state.lastMissed?.fireTime, missed.toISOString());

    const restarted = instance(missed.getTime() + 3 * 24 * HOUR);
    await restarted.start();
    assertEquals(
      restarted.scheduleStatus(workflow.id).lastMissed?.fireTime,
      missed.toISOString(),
    );
    await restarted.stop();
  });
});

Deno.test("schedule catch-up: a promoted follower catches up a slot the dead leader missed", async () => {
  await withCatchUpRepo(async ({ workflow, store, runs, instance }) => {
    const { previous, missed } = slots();
    let leading = false;
    const follower = instance(missed.getTime() + HOUR, {
      canWrite: () => leading,
    });
    await follower.start();

    await new ControlPlaneScheduleStateRepository(store).save({
      workflowId: workflow.id,
      workflowName: workflow.name,
      lastEvaluatedFireTime: previous.toISOString(),
      cronExpression: MONTHLY,
    });

    leading = true;
    await follower.catchUpMissedFires();
    await waitFor(() => runs.length === 1, "catch-up run");
    await follower.stop();

    const [state] = await new ControlPlaneScheduleStateRepository(store)
      .list();
    assertEquals(state.lastEvaluatedFireTime, missed.toISOString());
  });
});

Deno.test("schedule catch-up: a follower promoted after the leader fired the slot does not run it again", async () => {
  await withCatchUpRepo(async ({ workflow, store, runs, instance }) => {
    const { previous, missed } = slots();
    const shared = new ControlPlaneScheduleStateRepository(store);
    await shared.save({
      workflowId: workflow.id,
      workflowName: workflow.name,
      lastEvaluatedFireTime: previous.toISOString(),
      cronExpression: MONTHLY,
    });
    let leading = false;
    const follower = instance(missed.getTime() + 5 * HOUR, {
      canWrite: () => leading,
    });
    await follower.start();

    await shared.save({
      workflowId: workflow.id,
      workflowName: workflow.name,
      lastEvaluatedFireTime: missed.toISOString(),
      cronExpression: MONTHLY,
    });

    leading = true;
    await follower.catchUpMissedFires();
    await follower.stop();

    assertEquals(runs.length, 0);
    const [state] = await shared.list();
    assertEquals(state.lastMissed, undefined);
  });
});

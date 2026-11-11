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
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  type PendingRunOwner,
  RunTrackerStore,
} from "../src/infrastructure/persistence/run_tracker_store.ts";
import {
  ScheduledExecutionService,
  type WorkflowExecutor,
} from "../src/libswamp/workflows/scheduled_execution.ts";
import { ScheduledExecutionLifecycle } from "../src/serve/scheduled_execution_lifecycle.ts";
import { replayPendingRuns } from "../src/serve/boot_reconciliation.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

/** Yearly, so the test drives every run by replay rather than by the clock. */
const YEARLY = "0 0 1 1 *";
const ME: PendingRunOwner = { instanceId: crypto.randomUUID(), pid: 1 };
const GONE_PEER: PendingRunOwner = { instanceId: crypto.randomUUID(), pid: 2 };

interface Harness {
  readonly lifecycle: ScheduledExecutionLifecycle<ScheduledExecutionService>;
  readonly runTracker: RunTrackerStore;
  readonly runs: { workflow: string; release: () => void }[];
  readonly published: (ScheduledExecutionService | null)[];
  setLeads(leads: boolean): void;
  sweepReplay(): Promise<number>;
  pendingIds(): string[];
}

async function withScheduleReload(
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-sched-reload-" });
  const repoContext = createRepositoryContext({ repoDir });
  const runTracker = new RunTrackerStore(join(repoDir, "runs.db"));
  let lifecycle:
    | ScheduledExecutionLifecycle<ScheduledExecutionService>
    | undefined;
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
    for (const name of ["alpha", "beta", "gamma"]) {
      await repoContext.workflowRepo.save(Workflow.create({
        name,
        trigger: { schedule: YEARLY },
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "noop",
            task: StepTask.model("echo", "run", {}),
          })],
        })],
      }));
    }

    const runs: { workflow: string; release: () => void }[] = [];
    const executeWorkflow: WorkflowExecutor = (input, signal, onEvent) => {
      const done = Promise.withResolvers<void>();
      runs.push({ workflow: input.workflowIdOrName, release: done.resolve });
      signal.addEventListener("abort", () => done.resolve(), { once: true });
      onEvent({
        kind: "started",
        runId: crypto.randomUUID(),
        workflowName: input.workflowIdOrName,
        jobs: [],
      });
      return done.promise;
    };
    let configuredCronWorkflows: ReadonlySet<string> = new Set();
    let leads = true;
    const published: (ScheduledExecutionService | null)[] = [];
    let current: ScheduledExecutionService | null = null;
    const replay = (
      service: ScheduledExecutionService | null,
      extra: {
        ownCronOnly?: boolean;
        keepCronRuns?: boolean;
        createdBefore?: string;
      },
    ) =>
      replayPendingRuns({
        runTracker,
        scheduledExecution: service ?? undefined,
        configuredWebhookWorkflows: new Set(),
        configuredWebhookRoutes: new Set(),
        configuredCronWorkflows,
        claimAs: ME,
        ...extra,
      });
    lifecycle = new ScheduledExecutionLifecycle<ScheduledExecutionService>({
      build: (options) =>
        new ScheduledExecutionService({
          workflowRepo: repoContext.workflowRepo,
          repoDir,
          executeWorkflow,
          triggerOverrides: options.triggerOverrides,
          maxConcurrentRuns: options.maxConcurrentRuns,
          busyElsewhere: options.busyElsewhere,
          onRunSettled: options.onRunSettled,
          pendingRunHook: {
            enqueue: (entry) => {
              runTracker.enqueuePendingRun({ ...entry, owner: ME });
              return Promise.resolve();
            },
            delete: (id) => {
              runTracker.deletePendingRun(id);
              return Promise.resolve();
            },
          },
        }),
      start: async (service) => {
        configuredCronWorkflows = new Set(
          (await repoContext.workflowRepo.findAll())
            .filter((w) => w.schedule)
            .map((w) => w.name),
        );
        await service.start();
      },
      publish: (service) => {
        current = service;
        published.push(service);
      },
      leads: () => leads,
      replayOwnCron: (service, createdBefore) =>
        replay(service, { ownCronOnly: true, createdBefore }),
      maxConcurrentRuns: 1,
    });
    const h = lifecycle;
    await fn({
      lifecycle: h,
      runTracker,
      runs,
      published,
      setLeads: (value) => leads = value,
      sweepReplay: () => replay(current, { keepCronRuns: h.ranScheduler() }),
      pendingIds: () =>
        runTracker.findAllPendingRuns().map((entry) => entry.id).sort(),
    });
  } finally {
    await lifecycle?.drain(0);
    await lifecycle?.stop();
    runTracker.close();
    const cleanup = Deno.remove(repoDir, { recursive: true });
    await (Deno.build.os === "windows" ? cleanup.catch(() => {}) : cleanup);
  }
}

function pendingCron(
  runTracker: RunTrackerStore,
  id: string,
  workflow: string,
  owner: PendingRunOwner,
): void {
  runTracker.enqueuePendingRun({
    id,
    source: "cron",
    workflowIdOrName: workflow,
    // left by an earlier reload, so before any turn-on in the test
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    owner,
  });
}

Deno.test("serve schedule reload: scheduling turned off and back on keeps queued runs pending and replays each once", async () => {
  await withScheduleReload(async (h) => {
    pendingCron(h.runTracker, "p-alpha", "alpha", ME);
    pendingCron(h.runTracker, "p-beta", "beta", ME);
    await h.lifecycle.turnOn(undefined);
    await waitFor(() => h.runs.length === 1, "alpha runs, beta queued");
    assertEquals(h.runs[0].workflow, "alpha");
    assertEquals(h.pendingIds(), ["p-beta"]);

    await h.lifecycle.turnOff();
    assertEquals(h.lifecycle.enabled(), false);
    assertEquals(h.published.at(-1), null);
    // a run left by a peer that stopped arrives while scheduling is off
    pendingCron(h.runTracker, "p-gamma", "gamma", GONE_PEER);
    assertEquals(await h.sweepReplay(), 0);
    assertEquals(h.pendingIds(), ["p-beta", "p-gamma"]);

    await h.lifecycle.turnOn(undefined);
    const live = h.lifecycle.current()!;
    assertEquals(
      live.listSchedules().map((s) => s.workflowName).sort(),
      ["alpha", "beta", "gamma"],
    );
    await waitFor(() => h.runs.length === 2, "beta replayed");
    assertEquals(h.runs[1].workflow, "beta");
    assertEquals(
      await replayPendingRuns({
        runTracker: h.runTracker,
        scheduledExecution: live,
        configuredWebhookWorkflows: new Set(),
        configuredWebhookRoutes: new Set(),
        configuredCronWorkflows: new Set(["alpha", "beta", "gamma"]),
        claimAs: ME,
        ownCronOnly: true,
      }),
      0,
    );

    assertEquals(await h.sweepReplay(), 1);
    h.runs[1].release();
    await waitFor(() => h.runs.length === 3, "the peer's gamma replayed");
    assertEquals(h.runs[2].workflow, "gamma");

    h.runs[0].release();
    await waitFor(() => h.lifecycle.retiring().length === 0, "retired");
    assertEquals(h.runs.map((run) => run.workflow), ["alpha", "beta", "gamma"]);
  });
});

Deno.test("serve schedule reload: a concurrency change applies to the next queued run", async () => {
  await withScheduleReload(async (h) => {
    pendingCron(h.runTracker, "p-alpha", "alpha", ME);
    pendingCron(h.runTracker, "p-beta", "beta", ME);
    await h.lifecycle.turnOn(undefined);
    await waitFor(() => h.runs.length === 1, "one run at a time");
    h.lifecycle.setMaxConcurrentRuns(2);
    await waitFor(() => h.runs.length === 2, "the queued run starts");
    assertEquals(h.runs.map((run) => run.workflow).sort(), ["alpha", "beta"]);
  });
});

Deno.test("serve schedule reload: a node that does not lead replays nothing when scheduling is turned on", async () => {
  await withScheduleReload(async (h) => {
    pendingCron(h.runTracker, "p-alpha", "alpha", ME);
    h.setLeads(false);
    await h.lifecycle.turnOn(undefined);
    assertEquals(h.lifecycle.enabled(), true);
    assertEquals(h.runs.length, 0);
    assertEquals(h.pendingIds(), ["p-alpha"]);
  });
});

Deno.test("serve schedule reload: a run claimed at takeover is not queued again by the replay at the lead", async () => {
  await withScheduleReload(async (h) => {
    h.setLeads(false);
    await h.lifecycle.turnOn(undefined);
    pendingCron(h.runTracker, "p-alpha", "alpha", GONE_PEER);
    pendingCron(h.runTracker, "p-beta", "beta", GONE_PEER);
    h.setLeads(true);
    // the takeover's replay claims the dead leader's runs before onLed
    assertEquals(await h.sweepReplay(), 2);
    await waitFor(() => h.runs.length === 1, "alpha runs, beta queued");
    await h.lifecycle.atLead();
    h.runs[0].release();
    await waitFor(() => h.runs.length === 2, "beta runs");
    await waitFor(() => h.pendingIds().length === 0, "both consumed");
    assertEquals(h.runs.map((run) => run.workflow), ["alpha", "beta"]);
    assertEquals(
      h.lifecycle.current()!.queueStatus(
        h.lifecycle.current()!.listSchedules().find((s) =>
          s.workflowName === "beta"
        )!.workflowId,
      ).queued,
      0,
    );
  });
});

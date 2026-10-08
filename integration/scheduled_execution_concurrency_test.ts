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
 * Wires ScheduledExecutionService into the health collector the way serve
 * does, against a real repository: the scheduled-run limit lets different
 * workflows run together, a workflow never overlaps itself, and each
 * schedule's queue state reaches the snapshot and the per-token view
 * (swamp-club#3046).
 */

import { assertEquals } from "@std/assert";
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
  type ScheduledExecutionEvent,
  ScheduledExecutionService,
  type WorkflowExecutor,
} from "../src/libswamp/workflows/scheduled_execution.ts";
import { ComponentHealthChecker } from "../src/serve/component_health_checker.ts";
import { HealthCollector } from "../src/serve/health_collector.ts";
import {
  createHealthResourceResolver,
  healthSnapshotFor,
} from "../src/serve/health_snapshot_view.ts";
import { RunMetricsTracker } from "../src/serve/run_metrics_tracker.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

/** Yearly, so the test drives every run by replay rather than by the clock. */
const YEARLY = "0 0 1 1 *";

async function withScheduledRepo(
  maxConcurrentRuns: number | undefined,
  fn: (ctx: {
    service: ScheduledExecutionService;
    collector: HealthCollector;
    runs: { workflow: string; release: () => void }[];
    events: ScheduledExecutionEvent[];
    workflows: Map<string, Workflow>;
    resolver: ReturnType<typeof createHealthResourceResolver>;
    setNow: (ms: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-sched-conc-" });
  const repoContext = createRepositoryContext({ repoDir });
  let service: ScheduledExecutionService | undefined;
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
    const workflows = new Map<string, Workflow>();
    for (const name of ["alpha", "beta", "gamma"]) {
      const workflow = Workflow.create({
        name,
        trigger: { schedule: YEARLY },
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "noop",
            task: StepTask.model("echo", "run", {}),
          })],
        })],
      });
      await repoContext.workflowRepo.save(workflow);
      workflows.set(name, workflow);
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
    let now = 0;
    const events: ScheduledExecutionEvent[] = [];
    service = new ScheduledExecutionService({
      workflowRepo: repoContext.workflowRepo,
      repoDir,
      executeWorkflow,
      maxConcurrentRuns,
      now: () => now,
    });
    await service.start((event) => events.push(event));
    const collector = new HealthCollector({
      instanceId: "instance-1",
      deploymentMode: "local",
      startedAt: 0,
      isReady: () => true,
      activeRunRegistry: null,
      metricsTracker: new RunMetricsTracker(),
      componentChecker: new ComponentHealthChecker({
        checkDatastore: () =>
          Promise.resolve({
            healthy: true,
            message: "ok",
            latencyMs: 1,
            datastoreType: "filesystem",
          }),
      }),
      workerProvider: null,
      scheduleProvider: service,
      scheduleEnabled: true,
      webhookProvider: null,
      remoteOnly: false,
      snapshotMaxAgeMs: 0,
    });
    const resolver = createHealthResourceResolver({
      workflowRepo: repoContext.workflowRepo,
      definitionRepo: repoContext.definitionRepo,
    });
    await fn({
      service,
      collector,
      runs,
      events,
      workflows,
      resolver,
      setNow: (ms) => now = ms,
    });
  } finally {
    await service?.stop();
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

function replay(service: ScheduledExecutionService, ...names: string[]) {
  for (const name of names) {
    service.enqueueForReplay({
      pendingRunId: crypto.randomUUID(),
      workflowIdOrName: name,
    });
  }
}

Deno.test("scheduled execution concurrency: at the limit, different workflows run together and queue state reaches health", async () => {
  await withScheduledRepo(2, async (ctx) => {
    ctx.setNow(1_000);
    replay(ctx.service, "alpha", "alpha", "beta");
    await waitFor(() => ctx.runs.length === 2, "two runs in flight");
    assertEquals(ctx.runs.map((run) => run.workflow), ["alpha", "beta"]);

    const snapshot = await ctx.collector.collect();
    const byName = new Map(
      snapshot.scheduling.schedules.map((s) => [s.workflowName, s]),
    );
    assertEquals(byName.get("alpha")?.queued, 1);
    assertEquals(
      byName.get("alpha")?.oldestQueuedAt,
      new Date(1_000).toISOString(),
    );
    assertEquals(byName.get("beta")?.queued, 0);
    assertEquals(byName.get("gamma")?.queued, 0);
    assertEquals(byName.get("gamma")?.lastQueueDelayMs, null);

    ctx.setNow(4_000);
    ctx.runs[0].release();
    await waitFor(() => ctx.runs.length === 3, "second alpha run");
    assertEquals(ctx.runs[2].workflow, "alpha");
    const after = await ctx.collector.collect();
    const alpha = after.scheduling.schedules.find((s) =>
      s.workflowName === "alpha"
    );
    assertEquals(alpha?.queued, 0);
    assertEquals(alpha?.lastQueueDelayMs, 3_000);

    // A reader who may read only beta sees no queue data for alpha.
    const view = await healthSnapshotFor(after, {
      isAdmin: () => false,
      canRead: (resource) =>
        resource.kind === "workflow" && resource.name === "beta",
    }, ctx.resolver);
    assertEquals(
      view.scheduling.schedules.map((s) => s.workflowName),
      ["beta"],
    );
  });
});

Deno.test("scheduled execution concurrency: by default runs go one at a time in queue order", async () => {
  await withScheduledRepo(undefined, async (ctx) => {
    replay(ctx.service, "beta", "alpha", "gamma");
    for (const expected of [1, 2, 3]) {
      await waitFor(() => ctx.runs.length === expected, "next run");
      const snapshot = await ctx.collector.collect();
      // Everything not yet started is still queued behind the one run.
      assertEquals(
        snapshot.scheduling.schedules.reduce((n, s) => n + s.queued, 0),
        3 - expected,
      );
      ctx.runs[expected - 1].release();
    }
    assertEquals(ctx.runs.map((run) => run.workflow), [
      "beta",
      "alpha",
      "gamma",
    ]);
    assertEquals(
      ctx.events
        .filter((e) => e.kind === "schedule_started")
        .map((e) => e.workflowName),
      ["beta", "alpha", "gamma"],
    );
  });
});

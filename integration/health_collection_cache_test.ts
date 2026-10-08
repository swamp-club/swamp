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
 * Wires the health collector and resolver caches serve uses against a real
 * repository: many admin and non-admin readers within one window cost one
 * collection and one repository lookup per resource (swamp-club#2641).
 */

import { assertEquals } from "@std/assert";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import type { AccessResource } from "../src/domain/access/mod.ts";
import { Job } from "../src/domain/workflows/job.ts";
import type { WorkflowRepository } from "../src/domain/workflows/repositories.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import type { ReadAuthorizer } from "../src/serve/admin_auth.ts";
import { ComponentHealthChecker } from "../src/serve/component_health_checker.ts";
import { HealthCollector } from "../src/serve/health_collector.ts";
import {
  cachedHealthResourceResolver,
  createHealthResourceResolver,
  healthSnapshotFor,
} from "../src/serve/health_snapshot_view.ts";
import { RunMetricsTracker } from "../src/serve/run_metrics_tracker.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

function reader(
  admin: boolean,
  readable: (resource: AccessResource) => boolean,
): ReadAuthorizer {
  return { isAdmin: () => admin, canRead: readable };
}

Deno.test("health collection cache: readers in one window share one collection and one lookup per resource", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-health-cache-" });
  const repoContext = createRepositoryContext({ repoDir });
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
    await repoContext.workflowRepo.save(Workflow.create({
      name: "nightly",
      tags: { team: "ops" },
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "noop",
          task: StepTask.model("echo", "run", {}),
        })],
      })],
    }));

    let lookups = 0;
    const workflowRepo = repoContext.workflowRepo;
    const countingWorkflowRepo = new Proxy(workflowRepo, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "findByName") {
          return (...args: unknown[]) => {
            lookups++;
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    }) as WorkflowRepository;

    let probes = 0;
    let clock = 0;
    const collector = new HealthCollector({
      instanceId: "instance-1",
      deploymentMode: "local",
      startedAt: 0,
      isReady: () => true,
      activeRunRegistry: null,
      metricsTracker: new RunMetricsTracker(),
      componentChecker: new ComponentHealthChecker({
        checkDatastore: () => {
          probes++;
          return Promise.resolve({
            healthy: true,
            message: "ok",
            latencyMs: 1,
            datastoreType: "filesystem",
          });
        },
      }),
      workerProvider: null,
      scheduleProvider: {
        listSchedules: () => [{
          workflowId: "1",
          workflowName: "nightly",
          cronExpression: "0 3 * * *",
          nextRun: null,
        }],
        isRunning: () => false,
        queueStatus: () => ({
          queued: 0,
          oldestQueuedAt: null,
          lastQueueDelayMs: null,
        }),
      },
      scheduleEnabled: true,
      webhookProvider: null,
      remoteOnly: false,
      snapshotMaxAgeMs: 1_000,
      now: () => clock,
    });
    const resolver = cachedHealthResourceResolver(
      createHealthResourceResolver({
        workflowRepo: countingWorkflowRepo,
        definitionRepo: repoContext.definitionRepo,
      }),
      { ttlMs: 5_000, now: () => clock },
    );

    const admin = reader(true, () => true);
    const ops = reader(
      false,
      (resource) =>
        (resource.fields.tags as Record<string, string> | undefined)?.team ===
          "ops",
    );
    const nobody = reader(false, () => false);

    const read = async (who: ReadAuthorizer) =>
      await healthSnapshotFor(await collector.collect(), who, resolver);
    const views = await Promise.all(
      [admin, ops, nobody, ops, nobody, admin].map(read),
    );

    assertEquals(probes, 1);
    assertEquals(lookups, 1);
    assertEquals(views[0].components.length, 1);
    assertEquals(
      views[1].scheduling.schedules.map((s) => s.workflowName),
      ["nightly"],
    );
    assertEquals(views[2].scheduling.schedules, []);

    clock += 1_000;
    await read(ops);
    assertEquals(probes, 2);
    assertEquals(lookups, 1);

    clock += 4_000;
    await read(ops);
    assertEquals(probes, 3);
    assertEquals(lookups, 2);
  } finally {
    repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});

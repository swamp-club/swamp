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
import {
  classifyHealthStatus,
  HealthCollector,
  type HealthCollectorDeps,
  type HealthStatus,
} from "./health_collector.ts";
import { RunMetricsTracker } from "./run_metrics_tracker.ts";
import { ComponentHealthChecker } from "./component_health_checker.ts";

function makeDeps(
  overrides: Partial<HealthCollectorDeps> = {},
): HealthCollectorDeps {
  return {
    instanceId: "test-instance-id",
    deploymentMode: "standalone",
    startedAt: Date.now() - 10_000,
    isReady: () => true,
    activeRunRegistry: null,
    metricsTracker: new RunMetricsTracker(),
    componentChecker: new ComponentHealthChecker({}),
    workerProvider: null,
    scheduleProvider: null,
    scheduleEnabled: false,
    webhookProvider: null,
    remoteOnly: false,
    ...overrides,
  };
}

Deno.test("HealthCollector: collects minimal snapshot with no subsystems", async () => {
  const deps = makeDeps();
  const collector = new HealthCollector(deps);
  const snapshot = await collector.collect();

  assertEquals(snapshot.instanceId, "test-instance-id");
  assertEquals(snapshot.deploymentMode, "standalone");
  assertEquals(snapshot.remoteOnly, false);
  assertEquals(snapshot.ready, true);
  assertGreater(snapshot.uptimeMs, 0);
  assertEquals(snapshot.activeRuns, []);
  assertEquals(snapshot.workers, []);
  assertEquals(snapshot.scheduling.enabled, false);
  assertEquals(snapshot.scheduling.schedules, []);
  assertEquals(snapshot.webhooks, []);
  assertEquals(snapshot.components, []);
  assertEquals(snapshot.metrics.completions, 0);
  assertEquals(snapshot.metrics.latency, null);
});

Deno.test("HealthCollector: includes metrics from tracker", async () => {
  const tracker = new RunMetricsTracker();
  tracker.record("completed", 100);
  tracker.record("failed", 200);

  const deps = makeDeps({ metricsTracker: tracker });
  const collector = new HealthCollector(deps);
  const snapshot = await collector.collect();

  assertEquals(snapshot.metrics.completions, 1);
  assertEquals(snapshot.metrics.failures, 1);
});

Deno.test("HealthCollector: includes worker snapshots", async () => {
  const deps = makeDeps({
    workerProvider: {
      workers: () => [{
        name: "worker-1",
        instanceUuid: "uuid-1",
        labels: {},
        platform: "darwin",
        arch: "arm64",
        swampVersion: "1.0.0",
        status: "idle" as const,
        connected: true,
        capacity: 1,
        activeDispatchIds: [],
      }],
    },
  });

  const collector = new HealthCollector(deps);
  const snapshot = await collector.collect();

  assertEquals(snapshot.workers.length, 1);
  assertEquals(snapshot.workers[0].name, "worker-1");
  assertEquals(snapshot.workers[0].status, "idle");
});

Deno.test("HealthCollector: includes schedule entries", async () => {
  const deps = makeDeps({
    scheduleEnabled: true,
    scheduleProvider: {
      listSchedules: () => [{
        workflowId: "my-workflow",
        workflowName: "my-workflow-name",
        cronExpression: "*/5 * * * *",
        nextRun: new Date("2026-01-01T00:05:00Z"),
      }],
      isRunning: () => false,
    },
  });

  const collector = new HealthCollector(deps);
  const snapshot = await collector.collect();

  assertEquals(snapshot.scheduling.enabled, true);
  assertEquals(snapshot.scheduling.schedules.length, 1);
  assertEquals(snapshot.scheduling.schedules[0].workflowId, "my-workflow");
  assertEquals(
    snapshot.scheduling.schedules[0].workflowName,
    "my-workflow-name",
  );
  assertEquals(snapshot.scheduling.schedules[0].cronExpression, "*/5 * * * *");
  assertEquals(snapshot.scheduling.schedules[0].running, false);
});

Deno.test("HealthCollector: includes webhook endpoints", async () => {
  const deps = makeDeps({
    webhookProvider: {
      listEndpoints: () => [{
        route: "/hooks/github",
        workflowIdOrName: "deploy",
        scheme: "github",
      }],
    },
  });

  const collector = new HealthCollector(deps);
  const snapshot = await collector.collect();

  assertEquals(snapshot.webhooks.length, 1);
  assertEquals(snapshot.webhooks[0].route, "/hooks/github");
  assertEquals(snapshot.webhooks[0].workflow, "deploy");
});

Deno.test("HealthCollector: includes component health", async () => {
  const deps = makeDeps({
    componentChecker: new ComponentHealthChecker({
      checkDatastore: (_signal) =>
        Promise.resolve({
          healthy: true,
          message: "OK",
          latencyMs: 3,
          datastoreType: "filesystem",
        }),
    }),
  });

  const collector = new HealthCollector(deps);
  const snapshot = await collector.collect();

  assertEquals(snapshot.components.length, 1);
  assertEquals(snapshot.components[0].name, "datastore");
  assertEquals(snapshot.components[0].healthy, true);
});

Deno.test("HealthCollector: reports not ready", async () => {
  const deps = makeDeps({ isReady: () => false });
  const collector = new HealthCollector(deps);
  const snapshot = await collector.collect();

  assertEquals(snapshot.ready, false);
});

Deno.test("classifyHealthStatus: healthy when ready and all components healthy", () => {
  assertEquals(classifyHealthStatus(true, [{ healthy: true }]), "healthy");
});

Deno.test("classifyHealthStatus: healthy when ready and no components", () => {
  assertEquals(classifyHealthStatus(true, []), "healthy");
});

Deno.test("classifyHealthStatus: degraded when ready but some unhealthy", () => {
  assertEquals(
    classifyHealthStatus(true, [{ healthy: true }, { healthy: false }]),
    "degraded",
  );
});

Deno.test("classifyHealthStatus: unhealthy when not ready", () => {
  assertEquals(classifyHealthStatus(false, [{ healthy: true }]), "unhealthy");
});

Deno.test("HealthCollector: emits health transition on state change", async () => {
  const transitions: { previous: HealthStatus; current: HealthStatus }[] = [];
  let ready = true;

  const deps = makeDeps({
    isReady: () => ready,
    onHealthTransition: (previous, current) => {
      transitions.push({ previous, current });
    },
  });
  const collector = new HealthCollector(deps);

  await collector.collect();
  assertEquals(transitions.length, 0);

  ready = false;
  await collector.collect();
  assertEquals(transitions.length, 1);
  assertEquals(transitions[0].previous, "healthy");
  assertEquals(transitions[0].current, "unhealthy");

  ready = true;
  await collector.collect();
  assertEquals(transitions.length, 2);
  assertEquals(transitions[1].previous, "unhealthy");
  assertEquals(transitions[1].current, "healthy");
});

Deno.test("HealthCollector: no transition when status unchanged", async () => {
  const transitions: { previous: HealthStatus; current: HealthStatus }[] = [];

  const deps = makeDeps({
    isReady: () => true,
    onHealthTransition: (previous, current) => {
      transitions.push({ previous, current });
    },
  });
  const collector = new HealthCollector(deps);

  await collector.collect();
  await collector.collect();
  await collector.collect();
  assertEquals(transitions.length, 0);
});

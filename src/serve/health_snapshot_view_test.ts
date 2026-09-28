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

import { assertEquals, assertStrictEquals } from "@std/assert";
import type { AccessResource } from "../domain/access/mod.ts";
import type { ReadAuthorizer } from "./admin_auth.ts";
import type { HealthSnapshot } from "./health_collector.ts";
import { healthSnapshotFor } from "./health_snapshot_view.ts";

function snapshot(): HealthSnapshot {
  return {
    instanceId: "instance-1",
    deploymentMode: "local",
    remoteOnly: false,
    uptimeMs: 1000,
    ready: true,
    activeRuns: [
      {
        runId: "r1",
        kind: "workflow-run",
        resourceName: "nightly",
        durationMs: 5,
        principalId: "user:alice",
      },
      {
        runId: "r2",
        kind: "workflow-resume",
        resourceName: "secret-flow",
        durationMs: 5,
        principalId: "user:bob",
      },
      {
        runId: "r3",
        kind: "method-run",
        resourceName: "echo-model",
        durationMs: 5,
        principalId: "user:carol",
      },
    ],
    metrics: {
      windowMs: 300000,
      completions: 4,
      failures: 1,
      cancellations: 0,
      throughputPerMinute: 0.8,
      latency: null,
    },
    workers: [
      { name: "w1", status: "idle", activeDispatchIds: [] },
    ] as unknown as HealthSnapshot["workers"],
    scheduling: {
      enabled: true,
      schedules: [
        {
          workflowId: "1",
          workflowName: "nightly",
          cronExpression: "0 3 * * *",
          nextRun: null,
          running: false,
        },
        {
          workflowId: "2",
          workflowName: "secret-flow",
          cronExpression: "0 4 * * *",
          nextRun: null,
          running: false,
        },
      ],
    },
    webhooks: [
      { route: "/hooks/nightly", workflow: "nightly", scheme: "hmac" },
      { route: "/hooks/secret", workflow: "secret-flow", scheme: "hmac" },
    ],
    components: [
      {
        name: "datastore",
        healthy: false,
        message: "cannot reach s3://internal-bucket",
        latencyMs: 12,
      },
    ],
  };
}

function reader(
  admin: boolean,
  readable: (resource: AccessResource) => boolean = () => false,
): ReadAuthorizer & { asked: AccessResource[] } {
  const asked: AccessResource[] = [];
  return {
    asked,
    isAdmin: () => admin,
    canRead: (resource) => {
      asked.push(resource);
      return readable(resource);
    },
  };
}

Deno.test("healthSnapshotFor: an admin gets the snapshot unchanged", () => {
  const original = snapshot();
  assertStrictEquals(healthSnapshotFor(original, reader(true)), original);
});

Deno.test("healthSnapshotFor: a reader with no grants sees no names, routes, principals or deployment detail", () => {
  const view = healthSnapshotFor(snapshot(), reader(false));

  assertEquals(view.activeRuns, []);
  assertEquals(view.scheduling, { enabled: true, schedules: [] });
  assertEquals(view.webhooks, []);
  assertEquals(view.workers, []);
  assertEquals(view.components, []);
  assertEquals(view.instanceId, "instance-1");
  assertEquals(view.ready, true);
  assertEquals(view.metrics.completions, 4);
});

Deno.test("healthSnapshotFor: keeps what the reader may read, without run principals", () => {
  const r = reader(
    false,
    (resource) =>
      (resource.kind === "workflow" && resource.name === "nightly") ||
      (resource.kind === "model" && resource.name === "echo-model"),
  );
  const view = healthSnapshotFor(snapshot(), r);

  assertEquals(
    view.activeRuns.map((run) => [run.runId, run.principalId]),
    [["r1", null], ["r3", null]],
  );
  assertEquals(
    view.scheduling.schedules.map((s) => s.workflowName),
    ["nightly"],
  );
  assertEquals(view.webhooks.map((w) => w.route), ["/hooks/nightly"]);
});

Deno.test("healthSnapshotFor: method runs are checked as models, other runs as workflows", () => {
  const r = reader(false);
  healthSnapshotFor(snapshot(), r);

  const runChecks = r.asked.slice(0, 3);
  assertEquals(runChecks, [
    { kind: "workflow", name: "nightly", fields: { name: "nightly" } },
    { kind: "workflow", name: "secret-flow", fields: { name: "secret-flow" } },
    { kind: "model", name: "echo-model", fields: { name: "echo-model" } },
  ]);
});

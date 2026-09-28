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
import {
  type HealthResourceResolver,
  healthSnapshotFor,
} from "./health_snapshot_view.ts";

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

/**
 * Resolves the fixture's entries the way the repositories would: `wf-2` is the
 * id of `secret-flow`, `echo-model` is of type `@acme/echo`, and `ghost`
 * exists nowhere.
 */
const RESOLVER: HealthResourceResolver = {
  workflow: (idOrName) => {
    const name = idOrName === "wf-2" ? "secret-flow" : idOrName;
    if (!["nightly", "secret-flow"].includes(name)) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      kind: "workflow",
      name,
      fields: { name, tags: { team: name === "nightly" ? "ops" : "finance" } },
    });
  },
  model: (idOrName) =>
    Promise.resolve(
      idOrName === "echo-model"
        ? {
          kind: "model",
          name: "echo-model",
          fields: { name: "echo-model", modelType: "@acme/echo" },
        }
        : null,
    ),
};

Deno.test("healthSnapshotFor: an admin gets the snapshot unchanged", async () => {
  const original = snapshot();
  assertStrictEquals(
    await healthSnapshotFor(original, reader(true), RESOLVER),
    original,
  );
});

Deno.test("healthSnapshotFor: a reader with no grants sees no names, routes, principals or deployment detail", async () => {
  const view = await healthSnapshotFor(snapshot(), reader(false), RESOLVER);

  assertEquals(view.activeRuns, []);
  assertEquals(view.scheduling, { enabled: true, schedules: [] });
  assertEquals(view.webhooks, []);
  assertEquals(view.workers, []);
  assertEquals(view.components, []);
  assertEquals(view.instanceId, "instance-1");
  assertEquals(view.ready, true);
  assertEquals(view.metrics.completions, 4);
});

Deno.test("healthSnapshotFor: keeps what the reader may read, without run principals", async () => {
  const r = reader(
    false,
    (resource) =>
      (resource.kind === "workflow" && resource.name === "nightly") ||
      (resource.kind === "model" && resource.name === "echo-model"),
  );
  const view = await healthSnapshotFor(snapshot(), r, RESOLVER);

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

Deno.test("healthSnapshotFor: decides on resolved fields, so model-type and tag grants apply", async () => {
  const r = reader(false, () => true);
  await healthSnapshotFor(snapshot(), r, RESOLVER);

  const byName = new Map(r.asked.map((res) => [res.name, res]));
  assertEquals(byName.get("echo-model"), {
    kind: "model",
    name: "echo-model",
    fields: { name: "echo-model", modelType: "@acme/echo" },
  });
  assertEquals(byName.get("nightly")?.fields, {
    name: "nightly",
    tags: { team: "ops" },
  });

  const noAcme = reader(
    false,
    (resource) => resource.fields.modelType !== "@acme/echo",
  );
  const view = await healthSnapshotFor(snapshot(), noAcme, RESOLVER);
  assertEquals(view.activeRuns.map((run) => run.runId), ["r1", "r2"]);
});

Deno.test("healthSnapshotFor: an entry naming a workflow by id is decided on its name", async () => {
  const original = snapshot();
  const withId = {
    ...original,
    webhooks: [{ route: "/hooks/by-id", workflow: "wf-2", scheme: "hmac" }],
  };
  const denySecret = reader(
    false,
    (resource) => resource.name !== "secret-flow",
  );

  const view = await healthSnapshotFor(withId, denySecret, RESOLVER);

  assertEquals(view.webhooks, []);
});

Deno.test("healthSnapshotFor: an entry that cannot be resolved is hidden", async () => {
  const original = snapshot();
  const ghost = {
    ...original,
    activeRuns: [{ ...original.activeRuns[0], resourceName: "ghost" }],
    webhooks: [{ route: "/hooks/ghost", workflow: "ghost", scheme: "hmac" }],
  };

  const view = await healthSnapshotFor(
    ghost,
    reader(false, () => true),
    RESOLVER,
  );

  assertEquals(view.activeRuns, []);
  assertEquals(view.webhooks, []);
});

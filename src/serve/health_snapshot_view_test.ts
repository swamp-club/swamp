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

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { AccessResource } from "../domain/access/mod.ts";
import type { ReadAuthorizer } from "./admin_auth.ts";
import type { HealthSnapshot } from "./health_collector.ts";
import {
  cachedHealthResourceResolver,
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
          queued: 0,
          oldestQueuedAt: null,
          lastQueueDelayMs: null,
        },
        {
          workflowId: "2",
          workflowName: "secret-flow",
          cronExpression: "0 4 * * *",
          nextRun: null,
          running: false,
          queued: 0,
          oldestQueuedAt: null,
          lastQueueDelayMs: null,
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

Deno.test("healthSnapshotFor: queue data goes with its schedule, and nothing service-wide is added", async () => {
  const full = snapshot();
  const queued = {
    ...full,
    scheduling: {
      ...full.scheduling,
      schedules: full.scheduling.schedules.map((s) => ({
        ...s,
        queued: 2,
        oldestQueuedAt: "2026-01-01T00:00:00.000Z",
        lastQueueDelayMs: 1_500,
      })),
    },
  };
  const r = reader(
    false,
    (resource) => resource.kind === "workflow" && resource.name === "nightly",
  );
  const view = await healthSnapshotFor(queued, r, RESOLVER);

  assertEquals(view.scheduling.schedules.length, 1);
  assertEquals(view.scheduling.schedules[0].workflowName, "nightly");
  assertEquals(view.scheduling.schedules[0].queued, 2);
  assertEquals(view.scheduling.schedules[0].lastQueueDelayMs, 1_500);
  assertEquals(Object.keys(view.scheduling).sort(), ["enabled", "schedules"]);
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

/** Wraps RESOLVER, counting lookups per kind and name. */
function countingResolver(): {
  resolver: HealthResourceResolver;
  lookups: (key: string) => number;
} {
  const counts = new Map<string, number>();
  const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  return {
    resolver: {
      workflow: (idOrName) => {
        count(`workflow:${idOrName}`);
        return RESOLVER.workflow(idOrName);
      },
      model: (idOrName) => {
        count(`model:${idOrName}`);
        return RESOLVER.model(idOrName);
      },
    },
    lookups: (key) => counts.get(key) ?? 0,
  };
}

Deno.test("cachedHealthResourceResolver: reuses a resolution within the ttl", async () => {
  const { resolver, lookups } = countingResolver();
  let clock = 1_000;
  const cached = cachedHealthResourceResolver(resolver, {
    ttlMs: 5_000,
    now: () => clock,
  });

  const first = await cached.workflow("nightly");
  clock += 4_999;
  const second = await cached.workflow("nightly");

  assertEquals(lookups("workflow:nightly"), 1);
  assertStrictEquals(second, first);
});

Deno.test("cachedHealthResourceResolver: keeps workflows and models apart", async () => {
  const { resolver, lookups } = countingResolver();
  const cached = cachedHealthResourceResolver(resolver, {
    ttlMs: 5_000,
    now: () => 0,
  });

  assertEquals(await cached.model("nightly"), null);
  assertEquals((await cached.workflow("nightly"))?.kind, "workflow");
  assertEquals(lookups("model:nightly"), 1);
  assertEquals(lookups("workflow:nightly"), 1);
});

Deno.test("cachedHealthResourceResolver: resolves again once the ttl has passed", async () => {
  const { resolver, lookups } = countingResolver();
  let clock = 1_000;
  const cached = cachedHealthResourceResolver(resolver, {
    ttlMs: 5_000,
    now: () => clock,
  });

  await cached.model("echo-model");
  clock += 5_000;
  await cached.model("echo-model");

  assertEquals(lookups("model:echo-model"), 2);
});

Deno.test("cachedHealthResourceResolver: treats a backwards clock step as expired", async () => {
  const { resolver, lookups } = countingResolver();
  let clock = 10_000;
  const cached = cachedHealthResourceResolver(resolver, {
    ttlMs: 5_000,
    now: () => clock,
  });

  await cached.workflow("nightly");
  clock -= 1;
  await cached.workflow("nightly");

  assertEquals(lookups("workflow:nightly"), 2);
});

Deno.test("cachedHealthResourceResolver: concurrent callers share one lookup", async () => {
  const { resolver, lookups } = countingResolver();
  const cached = cachedHealthResourceResolver(resolver, {
    ttlMs: 5_000,
    now: () => 0,
  });

  await Promise.all([
    cached.workflow("wf-2"),
    cached.workflow("wf-2"),
    cached.workflow("wf-2"),
  ]);

  assertEquals(lookups("workflow:wf-2"), 1);
});

Deno.test("cachedHealthResourceResolver: does not keep a failed lookup", async () => {
  let fail = true;
  let calls = 0;
  const cached = cachedHealthResourceResolver({
    workflow: (idOrName) => {
      calls++;
      if (fail) return Promise.reject(new Error("repository unavailable"));
      return RESOLVER.workflow(idOrName);
    },
    model: RESOLVER.model,
  }, { ttlMs: 5_000, now: () => 0 });

  await assertRejects(
    () => cached.workflow("nightly"),
    Error,
    "repository unavailable",
  );
  fail = false;
  assertEquals((await cached.workflow("nightly"))?.name, "nightly");
  assertEquals(calls, 2);
});

Deno.test("cachedHealthResourceResolver: every reader is still judged on its own grants", async () => {
  const cached = cachedHealthResourceResolver(RESOLVER, {
    ttlMs: 5_000,
    now: () => 0,
  });
  const ops = reader(false, (r) =>
    r.fields.tags !== undefined &&
    (r.fields.tags as Record<string, string>).team === "ops");
  const nobody = reader(false);

  const opsView = await healthSnapshotFor(snapshot(), ops, cached);
  const nobodyView = await healthSnapshotFor(snapshot(), nobody, cached);

  assertEquals(
    opsView.scheduling.schedules.map((s) => s.workflowName),
    ["nightly"],
  );
  assertEquals(nobodyView.scheduling.schedules, []);
  assertEquals(nobodyView.activeRuns, []);
  assertEquals(nobodyView.webhooks, []);
});

Deno.test("cachedHealthResourceResolver: stays bounded when every entry is fresh", async () => {
  const { resolver, lookups } = countingResolver();
  const cached = cachedHealthResourceResolver(resolver, {
    ttlMs: 5_000,
    now: () => 0,
  });

  await cached.workflow("nightly");
  for (let i = 0; i < 1024; i++) await cached.workflow(`flow-${i}`);
  await cached.workflow("nightly");

  assertEquals(lookups("workflow:nightly"), 2);
});

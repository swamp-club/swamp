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
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { ComponentHealthChecker } from "../src/serve/component_health_checker.ts";
import { HealthCollector } from "../src/serve/health_collector.ts";
import { RunMetricsTracker } from "../src/serve/run_metrics_tracker.ts";
import {
  parseWebhookConfig,
  type WebhookConfigEntry,
} from "../src/serve/serve_config.ts";
import {
  resolveExtensionWebhookEndpoints,
  type VaultSecretResolver,
  type WebhookEndpoint,
  WebhookService,
} from "../src/serve/webhook.ts";
import {
  buildWebhookRouteTable,
  createWebhookRouteApplier,
  type WebhookRouteTableDeps,
} from "../src/serve/webhook_reload.ts";
import { emitWebhookRoutesApplied } from "../src/serve/webhook_route_audit.ts";
import {
  loadWebhookRouteFiles,
  snapshotWebhookRoutesDir,
} from "../src/serve/webhook_route_files.ts";
import { WebhookRoutesPoller } from "../src/serve/webhook_routes_poller.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

function vaultFor(state: { down: boolean }): VaultSecretResolver {
  return {
    get: (vaultName, key) => {
      if (state.down) return Promise.reject(new Error("vault timed out"));
      return vaultName === "hooks" && key !== "missing"
        ? Promise.resolve(`secret-${key}`)
        : Promise.resolve("");
    },
  };
}

async function parse(
  vault: VaultSecretResolver,
  configs: readonly WebhookConfigEntry[],
): Promise<WebhookEndpoint[]> {
  const parsed = await Promise.all(
    configs.map((entry) => parseWebhookConfig(entry, vault)),
  );
  return await resolveExtensionWebhookEndpoints(
    parsed,
    () => Promise.resolve(false),
    [],
  );
}

function routeFile(route: string, workflow = "deploy", key = "k"): string {
  return `route: ${route}\nworkflow: ${workflow}\nsecret: "@vault=hooks:${key}"\n`;
}

/** serve's startup and poll wiring, with real files, loader, service and health */
async function startServe(
  dir: string,
  configs: readonly WebhookConfigEntry[] = [],
) {
  const routesDir = join(dir, "webhook-routes");
  const vaultState = { down: false };
  const vault = vaultFor(vaultState);
  const deps: WebhookRouteTableDeps = {
    source: "config",
    parse: (configs) => parse(vault, configs),
    loadRouteFiles: () => loadWebhookRouteFiles(routesDir),
  };
  const initialTable = await buildWebhookRouteTable(deps, configs);
  const service = new WebhookService({
    repoDir: dir,
    syncGate: undefined,
    repoContext: {} as RepositoryContext,
    datastoreConfig: {} as DatastoreConfig,
    endpoints: [...initialTable.endpoints],
  });
  const events: AuditEvent[] = [];
  const auditEmitter = {
    emit: (event: AuditEvent) => events.push(event),
  } as unknown as AuditEmitter;
  const applier = createWebhookRouteApplier({
    ...deps,
    service,
    initialTable,
    onApplied: (record) =>
      emitWebhookRoutesApplied({ auditEmitter, instanceId: "i-1" }, record),
  });
  const poller = new WebhookRoutesPoller({
    intervalMs: 60_000,
    snapshot: () => snapshotWebhookRoutesDir(routesDir),
    apply: () => applier.reapplyRouteFiles({ trigger: "poll" }),
  });
  const health = new HealthCollector({
    instanceId: "i-1",
    deploymentMode: "standalone",
    startedAt: Date.now(),
    isReady: () => true,
    activeRunRegistry: null,
    metricsTracker: new RunMetricsTracker(),
    componentChecker: new ComponentHealthChecker({}),
    workerProvider: null,
    scheduleProvider: null,
    scheduleEnabled: false,
    webhookProvider: service,
    remoteOnly: false,
    webhookRouteFilesProvider: () => ({
      directory: routesDir,
      poll: poller.status(),
      ...applier.status(),
    }),
  });
  const live = () =>
    service.listEndpoints().map((e) => [e.route, e.file ?? e.source]);
  const workflowOf = (route: string) =>
    service.listEndpoints().find((e) => e.route === route)?.workflowIdOrName;
  const pollTwice = async () => {
    await poller.pollNow();
    await poller.pollNow();
  };
  return {
    routesDir,
    vaultState,
    service,
    applier,
    poller,
    health,
    events,
    live,
    workflowOf,
    pollTwice,
  };
}

Deno.test("webhook route files poll: a deploy alone adds, keeps, updates and removes a route", async () => {
  await withTempDir(async (dir) => {
    const serve = await startServe(dir);
    const { routesDir } = serve;
    await Deno.mkdir(routesDir);
    try {
      await serve.pollTwice();
      assertEquals(serve.events, []);

      await Deno.writeTextFile(
        join(routesDir, "push.yaml"),
        routeFile("/hooks/push"),
      );
      await serve.pollTwice();
      assertEquals(serve.live(), [["/hooks/push", "push.yaml"]]);
      assertEquals(serve.events.length, 1);
      assertEquals(serve.events[0].principalKind, "system");
      assertEquals(
        serve.events[0].detail,
        "trigger=poll added=/hooks/push(file:push.yaml)",
      );

      await Deno.writeTextFile(
        join(routesDir, "push.yaml"),
        "route: [unclosed",
      );
      await serve.pollTwice();
      assertEquals(serve.live(), [["/hooks/push", "push.yaml"]]);
      const broken = (await serve.health.collect()).webhookRouteFiles!;
      assertEquals(broken.kept.map((k) => [k.file, k.reason]), [[
        "push.yaml",
        "last_good",
      ]]);
      assertEquals(broken.lastApplied?.trigger, "poll");
      assertEquals(serve.events.length, 2);
      assertEquals(serve.events[1].outcome, "failure");

      await Deno.writeTextFile(
        join(routesDir, "push.yaml"),
        routeFile("/hooks/push", "release"),
      );
      await serve.pollTwice();
      assertEquals(serve.workflowOf("/hooks/push"), "release");
      const fixed = (await serve.health.collect()).webhookRouteFiles!;
      assertEquals(fixed.kept, []);
      assertEquals(fixed.poll?.lastError, null);

      await Deno.remove(join(routesDir, "push.yaml"));
      await serve.pollTwice();
      assertEquals(serve.live(), []);
      assertEquals(
        serve.events.at(-1)?.detail,
        "trigger=poll removed=/hooks/push(file:push.yaml)",
      );
    } finally {
      await serve.poller.stop();
      await serve.service.stop();
    }
  });
});

Deno.test("webhook route files poll: a file still being written is applied only once it settles", async () => {
  await withTempDir(async (dir) => {
    const serve = await startServe(dir);
    const { routesDir } = serve;
    await Deno.mkdir(routesDir);
    try {
      await serve.pollTwice();

      await Deno.writeTextFile(
        join(routesDir, "push.yaml"),
        "route: /hooks/pu",
      );
      await serve.poller.pollNow();
      await Deno.writeTextFile(
        join(routesDir, "push.yaml"),
        routeFile("/hooks/push"),
      );
      await serve.poller.pollNow();
      assertEquals(serve.live(), []);

      await serve.poller.pollNow();
      assertEquals(serve.live(), [["/hooks/push", "push.yaml"]]);
      assertEquals(serve.events.length, 1);
      assertEquals(serve.events[0].outcome, "success");
    } finally {
      await serve.poller.stop();
      await serve.service.stop();
    }
  });
});

Deno.test("webhook route files poll: a file added between startup and the first poll is applied", async () => {
  await withTempDir(async (dir) => {
    const routesDir = join(dir, "webhook-routes");
    await Deno.mkdir(routesDir);
    const serve = await startServe(dir);
    try {
      await Deno.writeTextFile(
        join(routesDir, "push.yaml"),
        routeFile("/hooks/push"),
      );
      await serve.pollTwice();
      assertEquals(serve.live(), [["/hooks/push", "push.yaml"]]);
    } finally {
      await serve.poller.stop();
      await serve.service.stop();
    }
  });
});

Deno.test("webhook route files poll: a clashing new file leaves the live route serving", async () => {
  await withTempDir(async (dir) => {
    const routesDir = join(dir, "webhook-routes");
    await Deno.mkdir(routesDir);
    await Deno.writeTextFile(join(routesDir, "a.yaml"), routeFile("/hooks/a"));
    const serve = await startServe(dir);
    try {
      assertEquals(serve.live(), [["/hooks/a", "a.yaml"]]);

      await Deno.writeTextFile(
        join(routesDir, "b.yaml"),
        routeFile("/hooks/a"),
      );
      await serve.pollTwice();

      assertEquals(serve.live(), [["/hooks/a", "a.yaml"]]);
      const status = (await serve.health.collect()).webhookRouteFiles!;
      assertEquals(status.refused.map((r) => r.file), ["b.yaml"]);
      assertEquals(status.kept.map((k) => k.file), ["a.yaml"]);
    } finally {
      await serve.poller.stop();
      await serve.service.stop();
    }
  });
});

Deno.test("webhook route files poll: a reload during a poll applies one after the other", async () => {
  await withTempDir(async (dir) => {
    const routesDir = join(dir, "webhook-routes");
    await Deno.mkdir(routesDir);
    const serve = await startServe(dir);
    try {
      await serve.poller.pollNow();
      await Deno.writeTextFile(
        join(routesDir, "a.yaml"),
        routeFile("/hooks/a"),
      );
      await Promise.all([
        serve.poller.pollNow(),
        serve.applier.update([], { trigger: "reload" }),
        serve.poller.pollNow(),
      ]);

      assertEquals(serve.live(), [["/hooks/a", "a.yaml"]]);
      assertEquals(serve.events.length, 1);
      assertEquals(serve.events[0].detail?.startsWith("trigger=reload"), true);
    } finally {
      await serve.poller.stop();
      await serve.service.stop();
    }
  });
});

Deno.test("webhook route files poll: a file deployed during a vault outage goes live once the vault answers", async () => {
  await withTempDir(async (dir) => {
    const serve = await startServe(dir);
    const { routesDir } = serve;
    await Deno.mkdir(routesDir);
    try {
      await serve.pollTwice();

      serve.vaultState.down = true;
      await Deno.writeTextFile(
        join(routesDir, "push.yaml"),
        routeFile("/hooks/push"),
      );
      await serve.pollTwice();
      await serve.poller.pollNow();
      assertEquals(serve.live(), []);
      assertEquals(
        (await serve.health.collect()).webhookRouteFiles?.poll?.lastError,
        "Some webhook route files failed on an outage; retrying on the next poll",
      );

      serve.vaultState.down = false;
      await serve.poller.pollNow();
      assertEquals(serve.live(), [["/hooks/push", "push.yaml"]]);
    } finally {
      await serve.poller.stop();
      await serve.service.stop();
    }
  });
});

Deno.test("webhook route files poll: a vault outage with serve.yaml routes still retries a deployed file", async () => {
  await withTempDir(async (dir) => {
    const serve = await startServe(dir, [{
      route: "/hooks/op",
      workflow: "deploy",
      secret: "@vault=hooks:op",
    }]);
    const { routesDir } = serve;
    await Deno.mkdir(routesDir);
    try {
      await serve.pollTwice();

      serve.vaultState.down = true;
      await Deno.writeTextFile(
        join(routesDir, "push.yaml"),
        routeFile("/hooks/push"),
      );
      for (let i = 0; i < 6; i++) await serve.poller.pollNow();
      assertEquals(serve.live(), [["/hooks/op", "config"]]);

      serve.vaultState.down = false;
      await serve.poller.pollNow();
      assertEquals(serve.live(), [
        ["/hooks/op", "config"],
        ["/hooks/push", "push.yaml"],
      ]);
    } finally {
      await serve.poller.stop();
      await serve.service.stop();
    }
  });
});

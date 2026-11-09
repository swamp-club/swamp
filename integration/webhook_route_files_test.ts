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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
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
import { createWebhookUpdater } from "../src/serve/webhook_reload.ts";
import { loadWebhookRouteFiles } from "../src/serve/webhook_route_files.ts";

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

const vault: VaultSecretResolver = {
  get: (vaultName, key) =>
    vaultName === "hooks" && key !== "missing"
      ? Promise.resolve(`secret-${key}`)
      : Promise.resolve(""),
};

async function parse(
  configs: readonly WebhookConfigEntry[],
): Promise<WebhookEndpoint[]> {
  const parsed = await Promise.all(
    configs.map((entry) => parseWebhookConfig(entry, vault)),
  );
  // no extension is installed here, so every extension scheme is unresolvable
  return await resolveExtensionWebhookEndpoints(
    parsed,
    () => Promise.resolve(false),
  );
}

function routeFile(route: string, key = "k", extra = ""): string {
  return `route: ${route}\nworkflow: deploy\nsecret: "@vault=hooks:${key}"\n${extra}`;
}

function harness(
  dir: string,
  source: "config" | "flag" = "config",
  flagEndpoints: WebhookEndpoint[] = [],
) {
  const service = new WebhookService({
    repoDir: dir,
    syncGate: undefined,
    repoContext: {} as RepositoryContext,
    datastoreConfig: {} as DatastoreConfig,
    endpoints: [],
  });
  const updater = createWebhookUpdater({
    source,
    service,
    parse,
    flagEndpoints,
    loadRouteFiles: () => loadWebhookRouteFiles(join(dir, "webhook-routes")),
  });
  return { service, updater };
}

async function isServed(
  service: WebhookService,
  route: string,
): Promise<boolean> {
  const response = await service.handleRequest(
    new Request(`http://localhost${route}`, { method: "POST", body: "{}" }),
  );
  return response !== null;
}

Deno.test("webhook route files: a file added then reloaded is served, and deleting it removes the route", async () => {
  await withTempDir(async (dir) => {
    const routes = join(dir, "webhook-routes");
    await Deno.mkdir(routes);
    const { service, updater } = harness(dir);
    try {
      await Deno.writeTextFile(
        join(routes, "push.yaml"),
        routeFile("/hooks/push"),
      );
      const added = await updater([]);

      assertEquals(added.changed, 1);
      assertEquals(added.errors, []);
      assertEquals(
        service.listEndpoints().map((e) => [e.route, e.source, e.file]),
        [["/hooks/push", "file", "push.yaml"]],
      );
      assertEquals(await isServed(service, "/hooks/push"), true);

      await Deno.remove(join(routes, "push.yaml"));
      const removed = await updater([]);

      assertEquals(removed.changed, 1);
      assertEquals(service.listEndpoints(), []);
      assertEquals(await isServed(service, "/hooks/push"), false);
    } finally {
      await service.stop();
    }
  });
});

Deno.test("webhook route files: a clash and a non-vault secret are refused while other routes apply", async () => {
  await withTempDir(async (dir) => {
    const routes = join(dir, "webhook-routes");
    await Deno.mkdir(routes);
    await Deno.writeTextFile(join(routes, "a.yaml"), routeFile("/hooks/same"));
    await Deno.writeTextFile(join(routes, "b.yaml"), routeFile("/hooks/same"));
    await Deno.writeTextFile(
      join(routes, "literal.yaml"),
      "route: /hooks/literal\nworkflow: deploy\nsecret: plain\n",
    );
    await Deno.writeTextFile(join(routes, "ok.yaml"), routeFile("/hooks/ok"));
    const { service, updater } = harness(dir);
    try {
      const result = await updater([]);

      assertEquals(service.listEndpoints().map((e) => e.route), ["/hooks/ok"]);
      assertEquals(result.errors.length, 3);
      assertStringIncludes(
        result.errors.join("\n"),
        "b.yaml also claims this route",
      );
      assertStringIncludes(
        result.errors.join("\n"),
        "Refused webhook route file literal.yaml (route /hooks/literal): the secret must be a vault reference",
      );
    } finally {
      await service.stop();
    }
  });
});

Deno.test("webhook route files: a serve config route shadows a file route on the same path", async () => {
  await withTempDir(async (dir) => {
    const routes = join(dir, "webhook-routes");
    await Deno.mkdir(routes);
    await Deno.writeTextFile(
      join(routes, "gh.yaml"),
      routeFile("/hooks/gh", "file-key"),
    );
    const { service, updater } = harness(dir);
    try {
      const result = await updater([
        {
          route: "/hooks/gh",
          workflow: "deploy",
          secret: "@vault=hooks:config-key",
        },
      ]);

      const [only] = service.listEndpoints();
      assertEquals([only.route, only.source], ["/hooks/gh", "config"]);
      assertEquals(result.warnings, [
        "Shadowed webhook route file gh.yaml (route /hooks/gh): the serve config " +
        "defines the same route, which serve uses instead",
      ]);
    } finally {
      await service.stop();
    }
  });
});

Deno.test("webhook route files: route files reload in flag mode while flag routes stay fixed", async () => {
  await withTempDir(async (dir) => {
    const routes = join(dir, "webhook-routes");
    await Deno.mkdir(routes);
    const [flag] = await parse([{
      route: "/hooks/flag",
      workflow: "deploy",
      secret: "@vault=hooks:f",
    }]);
    const { service, updater } = harness(dir, "flag", [flag]);
    try {
      await Deno.writeTextFile(join(routes, "a.yaml"), routeFile("/hooks/a"));
      await updater([]);

      assertEquals(
        service.listEndpoints().map((e) => [e.route, e.source]),
        [["/hooks/flag", "flag"], ["/hooks/a", "file"]],
      );
    } finally {
      await service.stop();
    }
  });
});

Deno.test("webhook route files: a missing vault key or an uninstalled scheme refuses only that file, and a serve config change still applies", async () => {
  await withTempDir(async (dir) => {
    const routes = join(dir, "webhook-routes");
    await Deno.mkdir(routes);
    await Deno.writeTextFile(
      join(routes, "nokey.yaml"),
      routeFile("/hooks/nokey", "missing"),
    );
    await Deno.writeTextFile(
      join(routes, "ext.yaml"),
      routeFile("/hooks/ext", "k", 'scheme: "@nobody/absent"\n'),
    );
    await Deno.writeTextFile(join(routes, "ok.yaml"), routeFile("/hooks/ok"));
    const { service, updater } = harness(dir);
    try {
      const result = await updater([
        {
          route: "/hooks/from-config",
          workflow: "deploy",
          secret: "@vault=hooks:c",
        },
      ]);

      assertEquals(
        service.listEndpoints().map((e) => e.route),
        ["/hooks/from-config", "/hooks/ok"],
      );
      assertEquals(result.errors.length, 2);
      assertStringIncludes(
        result.errors.join("\n"),
        "ext.yaml (route /hooks/ext)",
      );
      assertStringIncludes(
        result.errors.join("\n"),
        "nokey.yaml (route /hooks/nokey)",
      );
    } finally {
      await service.stop();
    }
  });
});

function aliasBomb(route: string): string {
  const lines = [
    `route: ${route}`,
    "workflow: deploy",
    'secret: "@vault=hooks:k"',
    'scheme: "@acme/hook"',
    "config:",
    `  l0: &l0 [${Array(9).fill('"xxxxxxxxxx"').join(",")}]`,
  ];
  for (let i = 1; i < 9; i++) {
    lines.push(`  l${i}: &l${i} [${Array(9).fill(`*l${i - 1}`).join(",")}]`);
  }
  return lines.join("\n") + "\n";
}

Deno.test("webhook route files: a YAML alias bomb is refused alone, and the reload after it still applies a serve config route", async () => {
  await withTempDir(async (dir) => {
    const routes = join(dir, "webhook-routes");
    await Deno.mkdir(routes);
    await Deno.writeTextFile(
      join(routes, "bomb.yaml"),
      aliasBomb("/hooks/bomb"),
    );
    await Deno.writeTextFile(join(routes, "ok.yaml"), routeFile("/hooks/ok"));
    const service = new WebhookService({
      repoDir: dir,
      syncGate: undefined,
      repoContext: {} as RepositoryContext,
      datastoreConfig: {} as DatastoreConfig,
      endpoints: [],
    });
    // the extension scheme resolves as if its type were installed
    const updater = createWebhookUpdater({
      source: "config",
      service,
      parse: (configs) =>
        Promise.all(configs.map((entry) => parseWebhookConfig(entry, vault))),
      loadRouteFiles: () => loadWebhookRouteFiles(routes),
    });
    try {
      const first = await updater([]);
      const second = await updater([
        { route: "/hooks/cfg9", workflow: "deploy", secret: "@vault=hooks:c" },
      ]);

      assertStringIncludes(first.errors.join("\n"), "bomb.yaml");
      assertStringIncludes(second.errors.join("\n"), "bomb.yaml");
      assertEquals(
        service.listEndpoints().map((e) => e.route),
        ["/hooks/cfg9", "/hooks/ok"],
      );
      assertEquals(await isServed(service, "/hooks/cfg9"), true);
    } finally {
      await service.stop();
    }
  });
});

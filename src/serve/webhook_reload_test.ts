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
import type { WebhookConfigEntry } from "./serve_config.ts";
import type { WebhookEndpoint } from "./webhook.ts";
import type { RouteFileLoad } from "./webhook_route_files.ts";
import { createWebhookUpdater, FLAG_ROUTES_WARNING } from "./webhook_reload.ts";

function entry(route: string): WebhookConfigEntry {
  return { route, workflow: "deploy", secret: "s3cret" };
}

function endpoint(route: string): WebhookEndpoint {
  return {
    route,
    workflowIdOrName: "deploy",
    secret: "s3cret",
    verifier: { scheme: "github" },
  };
}

function harness(
  source: "config" | "flag",
  options: {
    flagEndpoints?: WebhookEndpoint[];
    routeFiles?: RouteFileLoad;
    unresolvable?: string[];
  } = {},
) {
  const applied: (readonly WebhookEndpoint[])[] = [];
  const parsed: (readonly WebhookConfigEntry[])[] = [];
  const updater = createWebhookUpdater({
    source,
    service: {
      updateEndpoints: (endpoints) => {
        applied.push(endpoints);
        return endpoints.length;
      },
    },
    parse: (configs) => {
      parsed.push(configs);
      const bad = configs.find((c) => options.unresolvable?.includes(c.route));
      if (bad) {
        return Promise.reject(new Error(`no vault key for ${bad.route}`));
      }
      return Promise.resolve(configs.map((c) => endpoint(c.route)));
    },
    ...(options.flagEndpoints ? { flagEndpoints: options.flagEndpoints } : {}),
    ...(options.routeFiles
      ? { loadRouteFiles: () => Promise.resolve(options.routeFiles!) }
      : {}),
  });
  return { updater, applied, parsed };
}

function routeFile(file: string, route: string) {
  return {
    file,
    entry: { route, workflow: "deploy", secret: "@vault=hooks:key" },
  };
}

Deno.test("createWebhookUpdater: adds the first route to a service that started with none", async () => {
  const { updater, applied } = harness("config");

  const result = await updater([entry("/hooks/first")]);

  assertEquals(result, { changed: 1, warnings: [], errors: [] });
  assertEquals(applied.map((a) => a.map((e) => e.route)), [["/hooks/first"]]);
  assertEquals(applied[0][0].source, "config");
});

Deno.test("createWebhookUpdater: an empty list clears config routes without parsing", async () => {
  const { updater, applied, parsed } = harness("config");

  const result = await updater([]);

  assertEquals(result, { changed: 0, warnings: [], errors: [] });
  assertEquals(applied, [[]]);
  assertEquals(parsed, []);
});

Deno.test("createWebhookUpdater: flag routes are kept and a serve config list is warned about", async () => {
  const { updater, applied, parsed } = harness("flag", {
    flagEndpoints: [endpoint("/hooks/flag")],
  });

  const result = await updater([entry("/hooks/from-config")]);

  assertEquals(result.warnings, [FLAG_ROUTES_WARNING]);
  assertEquals(
    applied.map((a) => a.map((e) => [e.route, e.source])),
    [[["/hooks/flag", "flag"]]],
  );
  assertEquals(parsed, []);
});

Deno.test("createWebhookUpdater: flag routes with no serve config list reload silently", async () => {
  const { updater } = harness("flag", {
    flagEndpoints: [endpoint("/hooks/flag")],
  });

  const result = await updater([]);

  assertEquals(result.warnings, []);
  assertEquals(result.errors, []);
});

Deno.test("createWebhookUpdater: route files reload in flag mode alongside the fixed flag routes", async () => {
  const { updater, applied } = harness("flag", {
    flagEndpoints: [endpoint("/hooks/flag")],
    routeFiles: { files: [routeFile("a.yaml", "/hooks/a")], refused: [] },
  });

  await updater([]);

  assertEquals(
    applied[0].map((e) => [e.route, e.source, e.file]),
    [["/hooks/flag", "flag", undefined], ["/hooks/a", "file", "a.yaml"]],
  );
});

Deno.test("createWebhookUpdater: a serve config route shadows a file route on the same path", async () => {
  const { updater, applied } = harness("config", {
    routeFiles: {
      files: [
        routeFile("gh.yaml", "/hooks/gh"),
        routeFile("b.yaml", "/hooks/b"),
      ],
      refused: [],
    },
  });

  const result = await updater([entry("/hooks/gh")]);

  assertEquals(
    applied[0].map((e) => [e.route, e.source]),
    [["/hooks/gh", "config"], ["/hooks/b", "file"]],
  );
  assertEquals(result.warnings, [
    "Shadowed webhook route file gh.yaml (route /hooks/gh): the serve config " +
    "defines the same route, which serve uses instead",
  ]);
});

Deno.test("createWebhookUpdater: a route file that fails to parse is refused alone", async () => {
  const { updater, applied } = harness("config", {
    routeFiles: {
      files: [routeFile("a.yaml", "/hooks/a"), routeFile("b.yaml", "/hooks/b")],
      refused: [{
        file: "c.yaml",
        message: "Refused webhook route file c.yaml: bad",
      }],
    },
    unresolvable: ["/hooks/a"],
  });

  const result = await updater([entry("/hooks/op")]);

  assertEquals(
    applied[0].map((e) => e.route),
    ["/hooks/op", "/hooks/b"],
  );
  assertEquals(result.errors, [
    "Refused webhook route file c.yaml: bad",
    "Refused webhook route file a.yaml (route /hooks/a): no vault key for /hooks/a",
  ]);
});

Deno.test("createWebhookUpdater: a parse failure leaves the routes untouched", async () => {
  const applied: (readonly WebhookEndpoint[])[] = [];
  const updater = createWebhookUpdater({
    source: "config",
    service: {
      updateEndpoints: (endpoints) => {
        applied.push(endpoints);
        return endpoints.length;
      },
    },
    parse: () => Promise.reject(new Error("vault unreachable")),
  });

  let message = "";
  try {
    await updater([entry("/hooks/a")]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assertEquals(message, "vault unreachable");
  assertEquals(applied, []);
});

Deno.test("createWebhookUpdater: a routes directory that cannot be used drops file routes but still applies operator routes", async () => {
  const applied: (readonly WebhookEndpoint[])[] = [];
  const updater = createWebhookUpdater({
    source: "config",
    service: {
      updateEndpoints: (endpoints) => {
        applied.push(endpoints);
        return endpoints.length;
      },
    },
    parse: (configs) => Promise.resolve(configs.map((c) => endpoint(c.route))),
    loadRouteFiles: () =>
      Promise.reject(
        new Error("Webhook routes directory x holds extension code"),
      ),
  });

  const result = await updater([entry("/hooks/op")]);

  assertEquals(applied.map((a) => a.map((e) => e.route)), [["/hooks/op"]]);
  assertEquals(result.errors, [
    "Webhook routes directory x holds extension code",
  ]);
});

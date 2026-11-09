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

import { assertEquals, assertRejects } from "@std/assert";
import { UserError } from "../domain/errors.ts";
import { parseWebhookConfig, type WebhookConfigEntry } from "./serve_config.ts";
import type { WebhookEndpoint, WebhookRouteSource } from "./webhook.ts";
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

function harness(source: WebhookRouteSource) {
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
      return Promise.resolve(configs.map((c) => endpoint(c.route)));
    },
  });
  return { updater, applied, parsed };
}

Deno.test("createWebhookUpdater: adds the first route to a service that started with none", async () => {
  const { updater, applied } = harness("config");

  const result = await updater([entry("/hooks/first")]);

  assertEquals(result, { changed: 1, warnings: [] });
  assertEquals(applied.map((a) => a.map((e) => e.route)), [["/hooks/first"]]);
});

Deno.test("createWebhookUpdater: an empty list clears config routes without parsing", async () => {
  const { updater, applied, parsed } = harness("config");

  const result = await updater([]);

  assertEquals(result, { changed: 0, warnings: [] });
  assertEquals(applied, [[]]);
  assertEquals(parsed, []);
});

Deno.test("createWebhookUpdater: flag routes are never replaced and a file list is warned about", async () => {
  const { updater, applied, parsed } = harness("flag");

  const result = await updater([entry("/hooks/from-file")]);

  assertEquals(result, { changed: 0, warnings: [FLAG_ROUTES_WARNING] });
  assertEquals(applied, []);
  assertEquals(parsed, []);
});

Deno.test("createWebhookUpdater: flag routes with no file list reload silently", async () => {
  const { updater, applied } = harness("flag");

  const result = await updater([]);

  assertEquals(result, { changed: 0, warnings: [] });
  assertEquals(applied, []);
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

Deno.test("createWebhookUpdater: a reload with a reserved route is refused before the routes change", async () => {
  const applied: (readonly WebhookEndpoint[])[] = [];
  const updater = createWebhookUpdater({
    source: "config",
    service: {
      updateEndpoints: (endpoints) => {
        applied.push(endpoints);
        return endpoints.length;
      },
    },
    parse: (configs) => Promise.all(configs.map((c) => parseWebhookConfig(c))),
  });

  await assertRejects(
    () => updater([entry("/hooks/a"), entry("/api/v1/cancel")]),
    UserError,
    "Invalid webhook /api/v1/cancel: route '/api/v1/cancel' is under '/api'",
  );
  assertEquals(applied, []);
});

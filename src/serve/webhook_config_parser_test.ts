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
import { webhookTypeRegistry } from "../domain/webhooks/webhook_type_registry.ts";
import type { WebhookConfigEntry } from "./serve_config.ts";
import {
  type VaultSecretResolver,
  WebhookEnvironmentError,
} from "./webhook.ts";
import { createWebhookConfigParser } from "./webhook_config_parser.ts";
import type { ExtensionWebhookScheme } from "./webhook_verifiers.ts";

function vaults(secrets: Record<string, string>): VaultSecretResolver {
  return {
    get: (vaultName, key) => {
      const value = secrets[`${vaultName}:${key}`];
      return value === undefined
        ? Promise.reject(new Error(`backend timed out on ${key}`))
        : Promise.resolve(value);
    },
    getVaultNames: () => ["hooks"],
  };
}

function entry(route: string, key: string): WebhookConfigEntry {
  return { route, workflow: "deploy", secret: `@vault=hooks:${key}` };
}

Deno.test("createWebhookConfigParser: resolves each entry's vault secret", async () => {
  const parse = createWebhookConfigParser({
    openVaults: () => Promise.resolve(vaults({ "hooks:a": "secret-a" })),
    resolveType: () => Promise.resolve(false),
  });

  const [endpoint] = await parse([entry("/hooks/a", "a")]);

  assertEquals(endpoint.route, "/hooks/a");
  assertEquals(endpoint.secret, "secret-a");
  assertEquals(endpoint.verifier, { scheme: "github" });
});

Deno.test("createWebhookConfigParser: vaults that cannot be opened are an environment failure", async () => {
  const parse = createWebhookConfigParser({
    openVaults: () => Promise.reject(new Error("vault config unreadable")),
    resolveType: () => Promise.resolve(false),
  });

  await assertRejects(
    () => parse([entry("/hooks/a", "a")]),
    WebhookEnvironmentError,
    "vault config unreadable",
  );
});

Deno.test("createWebhookConfigParser: opens the vaults again on every parse", async () => {
  let opened = 0;
  const parse = createWebhookConfigParser({
    openVaults: () => {
      opened++;
      return Promise.resolve(vaults({ "hooks:a": "secret-a" }));
    },
    resolveType: () => Promise.resolve(false),
  });

  await parse([entry("/hooks/a", "a")]);
  await parse([entry("/hooks/a", "a")]);

  assertEquals(opened, 2);
});

Deno.test("createWebhookConfigParser: one failing entry fails the whole parse", async () => {
  const parse = createWebhookConfigParser({
    openVaults: () => Promise.resolve(vaults({ "hooks:a": "secret-a" })),
    resolveType: () => Promise.resolve(false),
  });

  await assertRejects(
    () => parse([entry("/hooks/a", "a"), entry("/hooks/b", "b")]),
    WebhookEnvironmentError,
    "backend timed out on b",
  );
});

Deno.test("createWebhookConfigParser: an extension scheme resolves through the injected resolver", async () => {
  const type: ExtensionWebhookScheme = `@test/hook-${crypto.randomUUID()}`;
  webhookTypeRegistry.register({
    type,
    name: "Test hook",
    description: "Test webhook extension",
    createHandler: () => ({
      signatureHeader: "x-token",
      requiredHeaders: ["x-token"],
      verify: () => true,
    }),
  });
  const resolved: string[] = [];
  const parse = createWebhookConfigParser({
    openVaults: () => Promise.resolve(vaults({ "hooks:a": "secret-a" })),
    resolveType: (t) => {
      resolved.push(t);
      return Promise.resolve(true);
    },
  });

  const [endpoint] = await parse([{
    ...entry("/hooks/a", "a"),
    scheme: type,
    config: { mode: "x" },
  }]);

  assertEquals(resolved, [type]);
  assertEquals(endpoint.verifier, { scheme: type, config: { mode: "x" } });
});

Deno.test("createWebhookConfigParser: a scheme lookup that throws is an environment failure", async () => {
  const parse = createWebhookConfigParser({
    openVaults: () => Promise.resolve(vaults({ "hooks:a": "secret-a" })),
    resolveType: () => Promise.reject(new Error("registry unreachable")),
  });

  await assertRejects(
    () =>
      parse([{ ...entry("/hooks/a", "a"), scheme: "@test/never", config: {} }]),
    WebhookEnvironmentError,
    "registry unreachable",
  );
});

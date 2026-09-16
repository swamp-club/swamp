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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type LazyWebhookEntry,
  type WebhookTypeInfo,
  WebhookTypeRegistry,
} from "./webhook_type_registry.ts";

function info(type: string): WebhookTypeInfo {
  return {
    type,
    name: `${type} webhook`,
    description: `A ${type} webhook`,
    createHandler: () => ({
      signatureHeader: "x-signature",
      requiredHeaders: [],
      verify: () => true,
    }),
  };
}

function lazy(type: string): LazyWebhookEntry {
  return {
    type,
    bundlePath: `/repo/.swamp/webhook-bundles/${type}.js`,
    sourcePath: `/repo/extensions/webhooks/${type}.ts`,
    version: "2026.01.15.1",
  };
}

Deno.test("WebhookTypeRegistry.register: get is case-insensitive", () => {
  const registry = new WebhookTypeRegistry();
  registry.register(info("@MyOrg/Hook"));

  assertEquals(registry.get("@myorg/hook")?.type, "@MyOrg/Hook");
  assertEquals(registry.has("@MYORG/HOOK"), true);
  assertEquals(registry.get("@myorg/other"), undefined);
  assertEquals(registry.getAll().length, 1);
});

Deno.test("WebhookTypeRegistry.register: throws on duplicate", () => {
  const registry = new WebhookTypeRegistry();
  registry.register(info("@myorg/hook"));
  assertThrows(
    () => registry.register(info("@myorg/hook")),
    Error,
    "already registered",
  );
});

Deno.test("WebhookTypeRegistry.registerLazy: indexed but not loaded", () => {
  const registry = new WebhookTypeRegistry();
  registry.registerLazy(lazy("@myorg/hook"));

  assertEquals(registry.has("@myorg/hook"), true);
  assertEquals(registry.isLazy("@myorg/hook"), true);
  assertEquals(registry.get("@myorg/hook"), undefined);
  assertEquals(registry.getAllLazy().map((e) => e.type), ["@myorg/hook"]);
});

Deno.test("WebhookTypeRegistry.registerLazy: skips already loaded type", () => {
  const registry = new WebhookTypeRegistry();
  registry.register(info("@myorg/hook"));
  registry.registerLazy(lazy("@myorg/hook"));
  assertEquals(registry.isLazy("@myorg/hook"), false);
});

Deno.test("WebhookTypeRegistry.ensureTypeLoaded: promotes lazy type once for concurrent callers", async () => {
  const registry = new WebhookTypeRegistry();
  registry.registerLazy(lazy("@myorg/hook"));

  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  registry.setTypeLoader(async (type) => {
    calls++;
    await gate;
    registry.promoteFromLazy(info(type));
  });

  const pending = Promise.all([
    registry.ensureTypeLoaded("@myorg/hook"),
    registry.ensureTypeLoaded("@myorg/hook"),
  ]);
  release();
  await pending;

  assertEquals(calls, 1);
  assertEquals(registry.isLazy("@myorg/hook"), false);
  assertEquals(registry.get("@myorg/hook")?.name, "@myorg/hook webhook");
});

Deno.test("WebhookTypeRegistry.ensureTypeLoaded: no-op for loaded and unknown types", async () => {
  const registry = new WebhookTypeRegistry();
  registry.register(info("@myorg/loaded"));
  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/loaded");
  await registry.ensureTypeLoaded("@myorg/unknown");
  assertEquals(called, false);
});

Deno.test("WebhookTypeRegistry.ensureTypeLoaded: retries after a failed load", async () => {
  const registry = new WebhookTypeRegistry();
  registry.registerLazy(lazy("@myorg/hook"));
  let calls = 0;
  registry.setTypeLoader((type) => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("transient"));
    registry.promoteFromLazy(info(type));
    return Promise.resolve();
  });

  await assertRejects(() => registry.ensureTypeLoaded("@myorg/hook"));
  await registry.ensureTypeLoaded("@myorg/hook");
  assertEquals(calls, 2);
  assertEquals(registry.get("@myorg/hook") !== undefined, true);
});

Deno.test("WebhookTypeRegistry.ensureLoaded: runs loader once until reset", async () => {
  const registry = new WebhookTypeRegistry();
  let calls = 0;
  registry.setLoader(() => {
    calls++;
    return Promise.resolve();
  });

  await registry.ensureLoaded();
  await registry.ensureLoaded();
  assertEquals(calls, 1);

  registry.resetLoadedFlag();
  await registry.ensureLoaded();
  assertEquals(calls, 2);
});

Deno.test("WebhookTypeRegistry.invalidateType: removes lazy and loaded types", () => {
  const registry = new WebhookTypeRegistry();
  registry.registerLazy(lazy("@myorg/a"));
  registry.register(info("@myorg/b"));

  registry.invalidateType("@myorg/a");
  registry.invalidateType("@MYORG/B");
  registry.invalidateType("@myorg/unknown");

  assertEquals(registry.has("@myorg/a"), false);
  assertEquals(registry.has("@myorg/b"), false);
});

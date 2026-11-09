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
import { z } from "zod";
import { webhookKindAdapter } from "./webhook_kind_adapter.ts";
import type { RegistrationContext } from "./kind_adapter.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import { webhookTypeRegistry } from "../webhooks/webhook_type_registry.ts";

function contextWith(
  origin: RegistrationContext["origin"],
): RegistrationContext {
  const denoRuntime: DenoRuntime = {
    ensureDeno: () => Promise.resolve("/usr/bin/false"),
    getDenoEnv: () => ({}),
  };
  return {
    absolutePath: "/ext/webhook.ts",
    denoPath: "/usr/bin/false",
    denoRuntime,
    repoDir: null,
    ...(origin ? { origin } : {}),
  };
}

function validExport(overrides: Record<string, unknown> = {}) {
  return {
    type: "@myorg/telegram",
    name: "Telegram",
    description: "Telegram bot webhook",
    configSchema: z.object({ botToken: z.string() }),
    createHandler: () => ({
      signatureHeader: "x-telegram-bot-api-secret-token",
      requiredHeaders: [],
      verify: () => true,
    }),
    ...overrides,
  };
}

Deno.test("webhookKindAdapter.validatePrimaryExport: accepts a valid webhook export", () => {
  const result = webhookKindAdapter.validatePrimaryExport(validExport());
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(
      webhookKindAdapter.normalizeType(result.data),
      "@myorg/telegram",
    );
  }
});

Deno.test("webhookKindAdapter.validatePrimaryExport: rejects unscoped type", () => {
  const result = webhookKindAdapter.validatePrimaryExport(
    validExport({ type: "telegram" }),
  );
  assertEquals(result.success, false);
});

Deno.test("webhookKindAdapter.validatePrimaryExport: rejects missing createHandler", () => {
  const result = webhookKindAdapter.validatePrimaryExport(
    validExport({ createHandler: "nope" }),
  );
  assertEquals(result.success, false);
});

Deno.test("webhookKindAdapter.extractTypeFromSource: reads type from export const webhook", () => {
  const source = [
    "export const webhook = {",
    '  type: "@MyOrg/Telegram",',
    '  name: "Telegram",',
    "  createHandler() {},",
    "};",
  ].join("\n");
  assertEquals(webhookKindAdapter.extractTypeFromSource(source), {
    typeNormalized: "@myorg/telegram",
    version: "",
    kind: "webhook",
    extendsType: "",
  });
  assertEquals(
    webhookKindAdapter.extractTypeFromSource("export const vault = {};"),
    null,
  );
});

Deno.test("webhookKindAdapter.extractTypeFromSource: ignores a declaration inside a comment (swamp-club#2876)", () => {
  assertEquals(
    webhookKindAdapter.extractTypeFromSource(
      '// export const webhook = { type: "@acme/thing" }',
    ),
    null,
  );
  const result = webhookKindAdapter.extractTypeFromSource(
    '// export const webhook = { type: "@acme/thing" }\n' +
      'export const webhook = { type: "@real/hook" };',
  );
  assertEquals(result?.typeNormalized, "@real/hook");
});

Deno.test("webhookKindAdapter.register: stores the origin the loader decided", () => {
  const type = `@myorg/hook-${crypto.randomUUID()}`;
  try {
    webhookKindAdapter.register(
      type,
      validExport({ type }),
      {},
      contextWith({ kind: "pulled", extensionName: "@myorg/hooks" }),
    );
    assertEquals(webhookTypeRegistry.get(type)?.origin, {
      kind: "pulled",
      extensionName: "@myorg/hooks",
    });
  } finally {
    webhookTypeRegistry.invalidateType(type);
  }
});

Deno.test("webhookKindAdapter.promoteFromLazy: stores the origin the loader decided", () => {
  const type = `@myorg/hook-${crypto.randomUUID()}`;
  try {
    webhookKindAdapter.registerLazy(
      {
        type_normalized: type,
        bundle_path: "/b.js",
        source_path: "/s.ts",
        version: "1",
      } as Parameters<typeof webhookKindAdapter.registerLazy>[0],
    );
    webhookKindAdapter.promoteFromLazy(
      type,
      validExport({ type }),
      {},
      contextWith({ kind: "local" }),
    );
    assertEquals(webhookTypeRegistry.get(type)?.origin, { kind: "local" });
  } finally {
    webhookTypeRegistry.invalidateType(type);
  }
});

Deno.test("webhookKindAdapter.register: leaves origin unset when the loader gave none", () => {
  const type = `@myorg/hook-${crypto.randomUUID()}`;
  try {
    webhookKindAdapter.register(
      type,
      validExport({ type }),
      {},
      contextWith(undefined),
    );
    assertEquals(webhookTypeRegistry.get(type)?.origin, undefined);
  } finally {
    webhookTypeRegistry.invalidateType(type);
  }
});

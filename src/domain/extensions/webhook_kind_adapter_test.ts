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

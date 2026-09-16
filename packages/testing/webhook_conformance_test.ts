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

// deno-lint-ignore-file no-import-prefix
import { assertRejects } from "jsr:@std/assert@1.0.19";
import {
  assertWebhookExportConformance,
  type WebhookExport,
  type WebhookExportConformanceOptions,
} from "./webhook_conformance.ts";

function staticTokenWebhook(verify?: () => boolean): WebhookExport {
  return {
    type: "@test/static-token",
    name: "Static token",
    description: "Compares a header to the secret",
    createHandler: () => ({
      signatureHeader: "x-token",
      requiredHeaders: ["x-token"],
      verify: verify ??
        ((_body, headers, secret) => headers.get("x-token") === secret),
    }),
  };
}

const options: WebhookExportConformanceOptions = {
  validRequest: { body: "{}", headers: { "x-token": "s" }, secret: "s" },
  invalidRequests: [
    { body: "{}", headers: { "x-token": "nope" }, secret: "s" },
    { body: "{}", headers: {}, secret: "s" },
  ],
};

Deno.test("assertWebhookExportConformance: passes for a conforming export", async () => {
  await assertWebhookExportConformance(staticTokenWebhook(), options);
});

Deno.test("assertWebhookExportConformance: fails when invalid requests verify", async () => {
  await assertRejects(() =>
    assertWebhookExportConformance(staticTokenWebhook(() => true), options)
  );
});

Deno.test("assertWebhookExportConformance: fails for a type without a collective", async () => {
  await assertRejects(() =>
    assertWebhookExportConformance(
      { ...staticTokenWebhook(), type: "static-token" },
      options,
    )
  );
});

Deno.test("assertWebhookExportConformance: passes schema-parsed config to createHandler", async () => {
  const base = staticTokenWebhook();
  await assertWebhookExportConformance({
    ...base,
    // Mimics z.object({ header: z.string().default("x-token") }).
    configSchema: {
      safeParse: (v) => ({
        success: true,
        data: { header: "x-token", ...(v as Record<string, unknown>) },
      }),
    },
    createHandler: (config) => ({
      ...base.createHandler(config),
      signatureHeader: config.header as string,
    }),
  }, options);
});

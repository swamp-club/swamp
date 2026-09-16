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
import { assertEquals, assertExists } from "jsr:@std/assert@1.0.19";
import type { WebhookHandler } from "./webhook_types.ts";

/**
 * The webhook export shape that extension authors must produce.
 * Matches the `export const webhook = { ... }` pattern.
 */
export interface WebhookExport {
  type: string;
  name: string;
  description: string;
  configSchema?: {
    safeParse: (v: unknown) => { success: boolean; data?: unknown };
  };
  createHandler: (config: Record<string, unknown>) => WebhookHandler;
}

/** A request fixture for {@link assertWebhookExportConformance}. */
export interface WebhookRequestFixture {
  body: string | Uint8Array;
  headers: Record<string, string>;
  secret: string;
}

/** Options for webhook export conformance. */
export interface WebhookExportConformanceOptions {
  /** Config passed to createHandler. Defaults to `{}`. */
  config?: Record<string, unknown>;
  /** Configs that should fail schema validation. */
  invalidConfigs?: Record<string, unknown>[];
  /** A request that must verify. */
  validRequest: WebhookRequestFixture;
  /** Requests that must not verify (forged, missing header, wrong secret). */
  invalidRequests: WebhookRequestFixture[];
}

async function verifies(
  handler: WebhookHandler,
  request: WebhookRequestFixture,
): Promise<boolean> {
  const body = typeof request.body === "string"
    ? new TextEncoder().encode(request.body)
    : request.body;
  const headers = new Headers(request.headers);
  // swamp serve rejects a request missing a required header before verify.
  if (handler.requiredHeaders.some((h) => !headers.get(h))) return false;
  try {
    return await handler.verify(body, headers, request.secret) === true;
  } catch {
    // swamp serve treats a throwing verifier as a rejection.
    return false;
  }
}

/**
 * Asserts that a webhook export has the correct shape and that its handler
 * accepts a valid request and rejects invalid ones the way `swamp serve`
 * evaluates them.
 *
 * ```typescript
 * import { assertWebhookExportConformance } from "@swamp-club/swamp-testing";
 * import { webhook } from "./my_webhook.ts";
 *
 * Deno.test("webhook export conforms", async () => {
 *   await assertWebhookExportConformance(webhook, {
 *     validRequest: { body: "{}", headers: { "x-token": "s" }, secret: "s" },
 *     invalidRequests: [{ body: "{}", headers: { "x-token": "x" }, secret: "s" }],
 *   });
 * });
 * ```
 */
export async function assertWebhookExportConformance(
  webhookExport: WebhookExport,
  options: WebhookExportConformanceOptions,
): Promise<void> {
  assertEquals(
    /^@[a-z0-9_-]+\/[a-z0-9_-]+$/.test(webhookExport.type),
    true,
    `webhook.type "${webhookExport.type}" must match @collective/name (lowercase)`,
  );
  assertEquals(
    webhookExport.name?.length > 0,
    true,
    "webhook.name must be non-empty",
  );
  assertEquals(
    webhookExport.description?.length > 0,
    true,
    "webhook.description must be non-empty",
  );

  let config = options.config ?? {};
  if (webhookExport.configSchema) {
    const parsed = webhookExport.configSchema.safeParse(config);
    assertEquals(
      parsed.success,
      true,
      `configSchema should accept ${JSON.stringify(config)}`,
    );
    // swamp serve hands createHandler the schema-parsed config (defaults,
    // coercions, transforms applied), so conformance must too.
    config = parsed.data as Record<string, unknown>;
    for (const invalid of options.invalidConfigs ?? []) {
      assertEquals(
        webhookExport.configSchema.safeParse(invalid).success,
        false,
        `configSchema should reject ${JSON.stringify(invalid)}`,
      );
    }
  }

  const handler = webhookExport.createHandler(config);
  assertExists(handler, "createHandler must return a handler");
  assertEquals(
    handler.signatureHeader.length > 0 &&
      handler.signatureHeader === handler.signatureHeader.toLowerCase(),
    true,
    "signatureHeader must be a non-empty lowercase header name",
  );
  for (const header of handler.requiredHeaders) {
    assertEquals(
      header,
      header.toLowerCase(),
      `requiredHeaders entry "${header}" must be lowercase`,
    );
  }
  assertEquals(typeof handler.verify, "function", "verify must be a function");

  assertEquals(
    await verifies(handler, options.validRequest),
    true,
    "handler must verify validRequest",
  );
  assertEquals(
    options.invalidRequests.length > 0,
    true,
    "At least one invalid request must be provided",
  );
  for (const [i, request] of options.invalidRequests.entries()) {
    assertEquals(
      await verifies(handler, request),
      false,
      `handler must reject invalidRequests[${i}]`,
    );
  }
}

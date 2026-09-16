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

/**
 * Type compatibility test for @swamp-club/swamp-testing webhook types.
 *
 * Verifies the testing package's webhook handler types stay structurally
 * compatible with swamp's canonical types in both directions. If either side
 * changes, this file fails to type-check.
 */

import type {
  WebhookHandler as CanonicalWebhookHandler,
  WebhookResponse as CanonicalWebhookResponse,
} from "./webhook_handler.ts";
import type { WebhookPayload as CanonicalWebhookPayload } from "../expressions/model_resolver.ts";
import type {
  WebhookHandler as TestingWebhookHandler,
  WebhookPayload as TestingWebhookPayload,
  WebhookResponse as TestingWebhookResponse,
} from "../../../packages/testing/webhook_types.ts";

function _toCanonical(handler: TestingWebhookHandler): CanonicalWebhookHandler {
  return handler;
}
function _toTesting(handler: CanonicalWebhookHandler): TestingWebhookHandler {
  return handler;
}
function _responses(
  a: TestingWebhookResponse,
  b: CanonicalWebhookResponse,
): [CanonicalWebhookResponse, TestingWebhookResponse] {
  return [a, b];
}
function _payloads(
  a: TestingWebhookPayload,
  b: CanonicalWebhookPayload,
): [CanonicalWebhookPayload, TestingWebhookPayload] {
  return [a, b];
}

Deno.test("testing package webhook types: compile-time compatibility check", () => {
  void [_toCanonical, _toTesting, _responses, _payloads];
});

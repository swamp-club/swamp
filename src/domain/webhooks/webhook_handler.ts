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

import type { WebhookPayload } from "../expressions/model_resolver.ts";

/**
 * A custom HTTP response returned by {@link WebhookHandler.respond}.
 * `enqueue` decides whether the verified request still starts a workflow run.
 */
export interface WebhookResponse {
  status: number;
  headers?: Record<string, string>;
  /** Serialized as JSON unless it is already a string. */
  body?: unknown;
  enqueue: boolean;
}

/**
 * Handles one webhook request for a `swamp serve` endpoint. Built-in schemes
 * implement only the verification members; extension types may also reshape
 * the payload and control the response.
 *
 * Core always runs, in order: required-header check, body size limit,
 * `verify`, header redaction, `transform`, `respond`, queue backpressure.
 * The hooks never run for a request that failed verification.
 */
export interface WebhookHandler {
  /** Lowercased header carrying the signature/secret — never exposed to workflows. */
  readonly signatureHeader: string;
  /** Lowercased headers that must be present before the body is read. */
  readonly requiredHeaders: readonly string[];
  verify(
    body: Uint8Array,
    headers: Headers,
    secret: string,
  ): Promise<boolean> | boolean;
  /**
   * Replaces the payload body exposed to the workflow. Receives the parsed
   * body and the already-redacted header map.
   */
  transform?(
    body: unknown,
    headers: Record<string, string>,
  ): unknown | Promise<unknown>;
  /** Overrides the default `200 {status:"queued"}` response. */
  respond?(
    payload: WebhookPayload,
  ): WebhookResponse | undefined | Promise<WebhookResponse | undefined>;
}

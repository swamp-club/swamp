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
 * Extension-author-facing subset of swamp's webhook types.
 *
 * These types mirror the webhook handler contract that `swamp serve` uses. A
 * CI test in the main swamp repo verifies structural compatibility with the
 * canonical types.
 */

/** The payload exposed to workflows via the `webhook` CEL namespace. */
export interface WebhookPayload {
  body: unknown;
  headers: Record<string, string>;
  route: string;
}

/** A custom HTTP response returned by {@link WebhookHandler.respond}. */
export interface WebhookResponse {
  status: number;
  headers?: Record<string, string>;
  /** Serialized as JSON unless it is already a string. */
  body?: unknown;
  /** Whether the verified request still starts a workflow run. */
  enqueue: boolean;
}

/**
 * Handles one webhook request. Hooks run only after `verify` succeeds, and
 * `transform` only sees headers with the signature and credential headers
 * removed.
 */
export interface WebhookHandler {
  /** Lowercased header carrying the signature/secret. */
  readonly signatureHeader: string;
  /** Lowercased headers that must be present before the body is read. */
  readonly requiredHeaders: readonly string[];
  verify(
    body: Uint8Array,
    headers: Headers,
    secret: string,
  ): Promise<boolean> | boolean;
  transform?(
    body: unknown,
    headers: Record<string, string>,
  ): unknown | Promise<unknown>;
  respond?(
    payload: WebhookPayload,
  ): WebhookResponse | undefined | Promise<WebhookResponse | undefined>;
}

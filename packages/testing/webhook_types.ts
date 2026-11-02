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

export interface WebhookPayload {
  body: unknown;
  headers: Record<string, string>;
  route: string;
}

export interface WebhookResponse {
  status: number;
  headers?: Record<string, string>;
  /** Serialized as JSON unless it is already a string. */
  body?: unknown;
  enqueue: boolean;
}

/**
 * handles one webhook request. Hooks run only after verify succeeds, and
 * transform sees headers with the signature and credential headers removed.
 */
export interface WebhookHandler {
  readonly signatureHeader: string;
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

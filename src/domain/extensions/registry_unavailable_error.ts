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

import { UserError } from "../errors.ts";

/**
 * The extension registry could not answer: the request timed out, the
 * connection failed, the server returned a 5xx, or the rate limit held after
 * retries. Distinct from an answer that the extension does not exist, so
 * auto-resolution can report an outage instead of "no extension publishes
 * this type" (swamp-club#3243).
 *
 * Reported under the name `UserError`, with the same messages and no code,
 * so CLI error output is what it was before the type existed. Readers of
 * `constructor.name` (telemetry's errorType, serve's exceptionType) see
 * `RegistryUnavailableError`.
 */
export class RegistryUnavailableError extends UserError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "UserError";
    // Non-enumerable like a native Error cause, so spreading or serialising
    // the error never carries the underlying failure into output.
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
}

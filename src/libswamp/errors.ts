// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/** Structured error returned in event streams. */
export interface SwampError {
  /** Machine-readable error code (e.g., "not_authenticated", "cancelled"). */
  readonly code: string;
  /** Human-readable error message. */
  readonly message: string;
  /** Original exception for stack traces (e.g., network errors, AbortError). */
  readonly cause?: Error;
  /** Additional structured data about the error. */
  readonly details?: unknown;
}

export function notAuthenticated(): SwampError {
  return {
    code: "not_authenticated",
    message: "Not authenticated. Run 'swamp auth login' to sign in.",
  };
}

export function invalidApiKey(): SwampError {
  return {
    code: "invalid_api_key",
    message:
      "Stored API key is no longer valid. Run 'swamp auth login' to re-authenticate.",
  };
}

export function cancelled(cause?: Error): SwampError {
  return {
    code: "cancelled",
    message: "Operation was cancelled.",
    cause,
  };
}

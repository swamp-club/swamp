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
 * Base error for user-facing errors that should not show a stack trace.
 * Use this for validation errors, "model not found" messages, and other
 * expected error conditions where the stack trace would be noise.
 *
 * The optional `code` carries a machine-readable identifier (e.g.
 * `"cancelled"`, `"timeout"`) that surfaces in JSON error output.
 */
export class UserError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "UserError";
    this.code = code;
  }
}

/**
 * Exhaustiveness check for switch statements.
 * TypeScript will error at compile time if a case is missing.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

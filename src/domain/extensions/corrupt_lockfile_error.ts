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

import { markErrorPaths, UserError } from "../errors.ts";

export const CORRUPT_LOCKFILE_CODE = "corrupt_lockfile";

// a SyntaxError so callers that retry or skip a torn lockfile read still catch it
export class CorruptLockfileError extends SyntaxError {
  readonly lockfilePath: string;
  constructor(message: string, lockfilePath: string) {
    super(message);
    this.name = "CorruptLockfileError";
    this.lockfilePath = lockfilePath;
  }
}

// a wrapped one is left alone: the wrapper may report what already landed
export function corruptLockfileUserErrorOf(
  error: unknown,
): UserError | undefined {
  if (!(error instanceof CorruptLockfileError)) return undefined;
  const userError = new UserError(error.message, CORRUPT_LOCKFILE_CODE);
  userError.cause = error;
  return markErrorPaths(userError, [error.lockfilePath]);
}

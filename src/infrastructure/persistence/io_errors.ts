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

const IO_ERROR_CODES = new Set([
  "EMFILE",
  "ENFILE",
  "EACCES",
  "EIO",
  "ENOSPC",
  "EROFS",
  "EPERM",
]);

/**
 * Distinguishes I/O and resource-exhaustion errors from YAML parse/validation
 * errors. Only parse errors belong in the "skip this file and keep going" path;
 * I/O errors must propagate so callers can surface an actionable message.
 */
export function isIoError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;

  if (typeof e.code === "string" && IO_ERROR_CODES.has(e.code)) {
    return true;
  }

  if (typeof e.message === "string") {
    for (const code of IO_ERROR_CODES) {
      if (e.message.includes(code)) return true;
    }
    if (e.message.includes("Too many open files")) return true;
    if (e.message.includes("Permission denied")) return true;
  }

  return false;
}

const SQLITE_TRANSIENT_RE = /database is (locked|busy)/i;

/**
 * Matches SQLite transient contention errors — "database is locked" or
 * "database is busy" — that arise when another process holds a write lock
 * past the busy_timeout.
 */
export function isSqliteTransientError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  if (typeof e.message === "string" && SQLITE_TRANSIENT_RE.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * Combined check for any transient error that should not be silently
 * swallowed: I/O resource-exhaustion errors OR SQLite lock contention.
 */
export function isTransientError(error: unknown): boolean {
  return isIoError(error) || isSqliteTransientError(error);
}

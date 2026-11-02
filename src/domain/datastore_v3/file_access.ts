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
 * only executable and private travel, never a full mode, owner or umask: a
 * checkout derives the mode from the one its own umask gave the new file
 */

export type FileAccess = "executable" | "private" | "private-executable";

const FILE_ACCESSES: readonly FileAccess[] = [
  "executable",
  "private",
  "private-executable",
];

/**
 * undefined for a plain file and when the platform reports no mode (Windows),
 * so a Windows writer records nothing
 */
export function fileAccessOf(mode: number | null): FileAccess | undefined {
  if (mode === null) return undefined;
  const executable = (mode & 0o111) !== 0;
  const isPrivate = (mode & 0o077) === 0;
  if (executable && isPrivate) return "private-executable";
  if (executable) return "executable";
  if (isPrivate) return "private";
  return undefined;
}

export function modeWithAccess(
  created: number,
  access: FileAccess | undefined,
): number {
  let mode = created & 0o777;
  if (access === "private" || access === "private-executable") {
    mode &= 0o700;
  }
  if (access === "executable" || access === "private-executable") {
    mode |= (mode & 0o444) >> 2;
  }
  return mode;
}

/**
 * a plain or executable file may be private too, since a restrictive umask
 * makes every new file so
 */
export function satisfiesAccess(
  mode: number,
  access: FileAccess | undefined,
): boolean {
  const executable = access === "executable" ||
    access === "private-executable";
  const isPrivate = access === "private" || access === "private-executable";
  if (((mode & 0o111) !== 0) !== executable) return false;
  return !isPrivate || (mode & 0o077) === 0;
}

export function readFileAccess(access: unknown): FileAccess | undefined {
  if (access === undefined) return undefined;
  if (FILE_ACCESSES.includes(access as FileAccess)) {
    return access as FileAccess;
  }
  throw new Error(
    `A file access must be one of ${FILE_ACCESSES.join(", ")}: ${
      String(access)
    }`,
  );
}

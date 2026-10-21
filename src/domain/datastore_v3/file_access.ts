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
 * The access a materialised file keeps besides its bytes (swamp-club#3693):
 * whether it is executable, and whether it is private (no group or other
 * access). A put records it from the file the writer staged, and every
 * checkout's read model gives the file it writes the same access, so an
 * output made executable runs anywhere and a 0600 file never widens.
 *
 * Only these two facts travel, never a full POSIX mode, owner or umask: the
 * mode a checkout writes is derived from the mode its own umask gave the
 * new file ({@link modeWithAccess}). A plain file records none.
 *
 * @module
 */

/** A file's access, when it is not a plain file. */
export type FileAccess = "executable" | "private" | "private-executable";

const FILE_ACCESSES: readonly FileAccess[] = [
  "executable",
  "private",
  "private-executable",
];

/**
 * The access a file with `mode` (as `Deno.FileInfo.mode` reports it) has:
 * executable when any execute bit is set, private when no group or other
 * bit is. Undefined for a plain file, and when the platform reports no mode
 * (Windows), so a Windows writer records nothing.
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

/**
 * The permission bits a file created with `created` gets for `access`:
 * private keeps only the owner's bits, executable adds an execute bit
 * wherever a read bit is set. Under umask 022 a new 0644 file becomes 0755,
 * 0600 or 0700; a plain file keeps its bits.
 */
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
 * Whether a file with `mode` already has `access`, whatever umask made it:
 * an execute bit exactly when the access is executable, and no group or
 * other bit when it is private. A plain or executable file may be private
 * as well, since a restrictive umask makes every new file so; a file
 * {@link modeWithAccess} derived always satisfies its access.
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

/** Throws unless `access` is undefined or a {@link FileAccess}. */
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

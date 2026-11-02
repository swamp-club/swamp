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
 * Windows: lowercase and forward slashes, as NTFS is case-insensitive; POSIX
 * unchanged, so case-insensitive macOS volumes may duplicate rows; a pure
 * string transform, so deleted paths pass through for backfill
 */
export function canonicalizePath(p: string): string {
  return canonicalizePathFor(p, Deno.build.os === "windows");
}

export function canonicalizePathFor(p: string, isWindows: boolean): string {
  if (isWindows) {
    return p.toLowerCase().replaceAll("\\", "/");
  }
  return p;
}

/**
 * The canonical form of `path` with symlinks resolved, or `path` itself
 * when it cannot be resolved (e.g. the file no longer exists).
 */
export function realCanonicalPath(path: string): string {
  try {
    return canonicalizePath(Deno.realPathSync(path));
  } catch {
    return path;
  }
}

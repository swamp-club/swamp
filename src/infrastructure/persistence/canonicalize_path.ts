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
 * Returns a canonical form of a filesystem path suitable for use as the
 * primary key in the extension catalog. Two paths that refer to the same
 * file on the host filesystem must produce the same canonical form.
 *
 * Rules (issue swamp-club#211, W1 — Repository and RowState):
 *
 *   - On Windows: lowercase the entire string and replace every backslash
 *     with a forward slash. NTFS is case-insensitive, and Node's path APIs
 *     can produce either separator depending on the call site, so two
 *     surface forms — `C:\\Users\\Foo\\Bar.ts` and `c:/users/foo/bar.ts` —
 *     refer to the same file. Without canonicalization the catalog would
 *     hold two distinct rows for one source.
 *   - On POSIX (Linux, macOS, *BSD, etc.): return the input unchanged.
 *     The issue explicitly recommends raw on POSIX to keep the function
 *     trivially predictable. Note that case-insensitive macOS filesystems
 *     (HFS+, APFS) can still produce duplicate rows under mixed-case
 *     access patterns; that is a known limitation accepted for W1.
 *
 * The function is intentionally a string transform — it does not stat the
 * filesystem, normalize `..`/`.` segments, or follow symlinks. Pass-through
 * for non-existent paths is required so the migration backfill can run
 * against catalog rows whose source files have already been deleted.
 */
export function canonicalizePath(p: string): string {
  return canonicalizePathFor(p, Deno.build.os === "windows");
}

/**
 * OS-parameterised form of {@link canonicalizePath}. Exposed so tests can
 * exercise both branches without running on different host OSes.
 */
export function canonicalizePathFor(p: string, isWindows: boolean): string {
  if (isWindows) {
    return p.toLowerCase().replaceAll("\\", "/");
  }
  return p;
}

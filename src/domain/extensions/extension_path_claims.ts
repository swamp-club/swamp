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
 * Ownership rules for the repo-relative paths an extension's lockfile
 * entry lists in `files[]`.
 *
 * Most tracked paths live in a per-extension subtree, so no two
 * extensions can list the same one. Skills are the exception: they land
 * in shared tool dirs (`.claude/skills/<name>`, ...), so two extensions,
 * or an extension and the user, can write into the same skill dir.
 * These rules decide when a path is claimed by an entry, so the delete
 * paths (extension rm, the install orphan prune) never remove a dir
 * another extension still owns files in.
 *
 * Paths are compared in a canonical form: forward slashes, NFC, case
 * folded, no trailing slash. macOS and Windows filesystems are
 * case-insensitive, and lockfiles written on Windows use backslashes,
 * so two spellings of one directory must compare equal.
 */

/** Minimal lockfile entry shape the claim rules read. */
export interface PathClaimEntry {
  files?: ReadonlyArray<string>;
}

/** Returns the canonical comparison form of a repo-relative path. */
export function canonicalClaimPath(path: string): string {
  let out = path.replaceAll("\\", "/").normalize("NFC").toLowerCase();
  while (out.length > 1 && out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

/** True when `path` equals `dir` or lies under it. */
export function pathCovers(dir: string, path: string): boolean {
  const d = canonicalClaimPath(dir);
  const p = canonicalClaimPath(path);
  return p === d || p.startsWith(d + "/");
}

/**
 * True when `files` claim `dir`: some listed path equals `dir` or lies
 * under it. An entry that recorded a skill root, or recorded the files
 * it merged into that root, both own the root for conflict purposes.
 */
export function claimsPath(
  files: ReadonlyArray<string>,
  dir: string,
): boolean {
  return files.some((f) => pathCovers(dir, f));
}

/**
 * Returns the names of lockfile entries, other than `selfName`, that
 * claim `path` (list it, or list something under it). Sorted for
 * stable output.
 */
export function findClaimants(
  path: string,
  selfName: string,
  entries: Readonly<Record<string, PathClaimEntry>>,
): string[] {
  const out: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (name === selfName) continue;
    if (claimsPath(entry.files ?? [], path)) out.push(name);
  }
  return out.sort();
}

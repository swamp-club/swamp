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
 * skills share tool dirs, so delete paths must never remove a dir another
 * extension still owns; paths compare in canonical form (forward slashes, NFC,
 * case-folded) since filesystems and lockfiles vary
 */

export interface PathClaimEntry {
  files?: ReadonlyArray<string>;
}

export function canonicalClaimPath(path: string): string {
  let out = path.replaceAll("\\", "/").normalize("NFC").toLowerCase();
  while (out.length > 1 && out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

export function pathCovers(dir: string, path: string): boolean {
  const d = canonicalClaimPath(dir);
  const p = canonicalClaimPath(path);
  return p === d || p.startsWith(d + "/");
}

/**
 * an entry that recorded a skill root, or the files it merged into that root,
 * owns the root for conflict purposes
 */
export function claimsPath(
  files: ReadonlyArray<string>,
  dir: string,
): boolean {
  return files.some((f) => pathCovers(dir, f));
}

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

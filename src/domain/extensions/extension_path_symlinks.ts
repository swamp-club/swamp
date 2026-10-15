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

import { dirname, resolve, SEPARATOR } from "@std/path";

/**
 * An extension file is refused if any component of its path, from the root
 * it lives under down to the file itself, is a symlink (swamp-club#3421).
 * Push never follows one: what an extension packages is the tree as the
 * author laid it out, so its archive never holds a symlink or a file
 * reached through one. Symlinks above the root (a repository under macOS
 * /tmp or a symlinked home directory) are not the extension's and are
 * allowed.
 */

function isSameOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + SEPARATOR);
}

/**
 * The paths whose symlink status decides whether `path` is refused: each
 * component from just below the outermost root that contains it down to
 * `path` itself, outermost first. A path under no root is checked only by
 * its own last component, which a symlinked file always is. Computed from
 * the paths alone; nothing is read.
 */
export function pathComponentsToCheck(
  path: string,
  roots: readonly string[],
): string[] {
  const file = resolve(path);
  const containing = roots.map((r) => resolve(r))
    .filter((r) => r !== file && isSameOrUnder(file, r))
    .sort((a, b) => a.length - b.length);
  const root = containing[0];
  if (root === undefined) return [file];
  const components: string[] = [];
  for (let p = file; p !== root; p = dirname(p)) components.push(p);
  return components.reverse();
}

/**
 * The first component of `path` that is a symlink, outermost first, or
 * undefined when none is. `isSymlink` answers for one component without
 * following it.
 */
export async function firstSymlinkedComponent(
  path: string,
  roots: readonly string[],
  isSymlink: (component: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const component of pathComponentsToCheck(path, roots)) {
    if (await isSymlink(component)) return component;
  }
  return undefined;
}

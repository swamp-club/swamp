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
 * a symlink in any component from the root down is refused: push never follows
 * one, so an archive holds no symlink or file reached through one; symlinks
 * above the root are not the extension's and are allowed
 */

function isSameOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + SEPARATOR);
}

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

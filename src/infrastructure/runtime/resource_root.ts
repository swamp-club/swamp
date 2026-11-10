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

import { dirname, join, resolve, toFileUrl } from "@std/path";

// always embedded by the compile script and present in every checkout, so the
// walk does not depend on how deep this module, or its bundled chunk, sits
const MARKER = join(".claude", "skills");

let cachedRoot: string | undefined;

function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) return false;
    throw error;
  }
}

export function findResourceRoot(startDir: string): string {
  let dir = resolve(startDir);
  while (true) {
    if (isDirectory(join(dir, MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `No swamp resource root found: no ancestor of ${
          resolve(startDir)
        } holds ${MARKER}`,
      );
    }
    dir = parent;
  }
}

/** resolved on first call, never at import, so module evaluation order cannot matter */
export function resourceRoot(): string {
  cachedRoot ??= findResourceRoot(import.meta.dirname ?? ".");
  return cachedRoot;
}

export function resourcePath(...segments: string[]): string {
  return join(resourceRoot(), ...segments);
}

export function resourceRootUrl(): string {
  const href = toFileUrl(resourceRoot()).href;
  return href.endsWith("/") ? href : `${href}/`;
}

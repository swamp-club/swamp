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

import { canonicalizePath } from "../../infrastructure/persistence/canonicalize_path.ts";

/**
 * equality is by canonicalPath only, folded for case-insensitive filesystems;
 * one canonicalPath with different extensionRoots is an aggregate bug this
 * value object does not validate
 */
export interface SourceLocation {
  readonly canonicalPath: string;
  readonly extensionRoot: string;
  readonly relativePath: string;
}

/**
 * the caller ensures absolutePath lives under extensionRoot; a violation is an
 * aggregate-level invariant surfaced by Extension, not here
 */
export function makeSourceLocation(
  absolutePath: string,
  extensionRoot: string,
): SourceLocation {
  const canonicalPath = canonicalizePath(absolutePath);
  const canonicalRoot = canonicalizePath(extensionRoot);
  return {
    canonicalPath,
    extensionRoot: canonicalRoot,
    relativePath: lexicalRelative(canonicalRoot, canonicalPath),
  };
}

export function sourceLocationEquals(
  a: SourceLocation,
  b: SourceLocation,
): boolean {
  return a.canonicalPath === b.canonicalPath;
}

/**
 * both inputs must already be canonicalized; canonicalizePath turns backslashes
 * into forward slashes on Windows, so the separator stripped is always /
 */
function lexicalRelative(parent: string, child: string): string {
  if (!child.startsWith(parent)) return child;
  const tail = child.slice(parent.length);
  return tail.startsWith("/") ? tail.slice(1) : tail;
}

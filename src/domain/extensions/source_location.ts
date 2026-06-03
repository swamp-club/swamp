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
 * Identifies a single Source within an Extension aggregate.
 *
 * Three pieces of identity:
 *   - `canonicalPath`: case/separator-folded full path to the source `.ts`
 *     entry point. Used for equality. On case-insensitive filesystems
 *     (Windows always; macOS HFS+/APFS in their default config) two
 *     surface forms (`EXTENSIONS/Models/A.ts`, `extensions/models/a.ts`)
 *     resolve to the same canonical form.
 *   - `extensionRoot`: the directory the owning Extension considers its
 *     root. For pulled extensions this is the per-extension subtree
 *     (`<repo>/.swamp/pulled-extensions/@scope/foo`). For locals this is
 *     the repo root (NOT a per-kind directory — locals share one synthetic
 *     aggregate spanning every `extensions/<kind>/` tree).
 *   - `relativePath`: lexically `canonicalPath` rebased on
 *     `canonicalize(extensionRoot)`, kept for diagnostics and registration
 *     paths that need a stable short name.
 *
 * Equality is **by canonicalPath only**. Two SourceLocations with the
 * same canonicalPath but different extensionRoots are an aggregate-level
 * bug (an invariant the aggregate enforces). The value object itself
 * accepts the inputs and exposes them; it does not validate the
 * relationship.
 */
export interface SourceLocation {
  readonly canonicalPath: string;
  readonly extensionRoot: string;
  readonly relativePath: string;
}

/**
 * Constructs a SourceLocation. `absolutePath` and `extensionRoot` are
 * canonicalized via {@link canonicalizePath}; `relativePath` is computed
 * by lexical-rebase of the canonicalized absolutePath onto the
 * canonicalized extensionRoot. Caller is responsible for ensuring
 * `absolutePath` actually lives under `extensionRoot` — a path that
 * doesn't is an aggregate-level invariant violation, surfaced by Extension
 * (I1), not here.
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

/**
 * Equality by canonicalPath. Two SourceLocations are equal iff their
 * canonicalPath strings match.
 */
export function sourceLocationEquals(
  a: SourceLocation,
  b: SourceLocation,
): boolean {
  return a.canonicalPath === b.canonicalPath;
}

/**
 * Lexically rebases `child` on `parent`. Returns the substring of `child`
 * after `parent` plus a separator, or `child` unchanged if it doesn't
 * start with `parent`. Both inputs must already be canonicalized — this
 * function does no path normalization.
 *
 * On Windows, canonicalizePath has already converted backslashes to
 * forward slashes, so the separator we strip is always `/`.
 */
function lexicalRelative(parent: string, child: string): string {
  if (!child.startsWith(parent)) return child;
  const tail = child.slice(parent.length);
  // Strip a leading separator if present. canonicalizePath collapses
  // backslashes to forward slashes on Windows, so `/` is sufficient.
  return tail.startsWith("/") ? tail.slice(1) : tail;
}

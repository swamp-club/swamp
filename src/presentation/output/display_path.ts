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

import { isAbsolute, normalize, parse, relative, SEPARATOR } from "@std/path";

/** The first path segment below the root, compared case-insensitively on Windows. */
function topSegment(path: string, root: string): string {
  const segment = path.slice(root.length).split(SEPARATOR)[0];
  return SEPARATOR === "\\" ? segment.toLowerCase() : segment;
}

/** Whether `path` is `dir` or below it. */
function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) && !isAbsolute(rel));
}

/**
 * The form of `path` an author can open from `cwd`. A file under `cwd`
 * prints relative to it. A file under one of `roots` (the extension and the
 * repo being pushed) also prints relative to `cwd` when the two share an
 * ancestor below the filesystem root, so a sibling extension reads
 * `../other/manifest.yaml`. Anything else prints absolute: a file outside
 * the pushed content (the review report under the temp dir), one that
 * shares only the root with `cwd`, or one on another Windows drive. A path
 * that is not absolute is returned unchanged; callers resolve repo-relative
 * names first.
 */
export function displayPath(
  path: string,
  cwd: string,
  roots: readonly string[] = [],
): string {
  if (!isAbsolute(path)) return path;
  const target = normalize(path);
  const base = normalize(cwd);
  const targetRoot = parse(target).root;
  const baseRoot = parse(base).root;
  const sameRoot = SEPARATOR === "\\"
    ? targetRoot.toLowerCase() === baseRoot.toLowerCase()
    : targetRoot === baseRoot;
  if (!sameRoot) return target;
  if (isWithin(target, base)) return relative(base, target) || ".";
  const sharesBelowRoot =
    topSegment(target, targetRoot) === topSegment(base, baseRoot);
  const inPushedContent = roots.some((root) =>
    isWithin(target, normalize(root))
  );
  return sharesBelowRoot && inPushedContent ? relative(base, target) : target;
}

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

function topSegment(path: string, root: string): string {
  const segment = path.slice(root.length).split(SEPARATOR)[0];
  return SEPARATOR === "\\" ? segment.toLowerCase() : segment;
}

function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) && !isAbsolute(rel));
}

/**
 * relative to cwd for files under cwd or sharing an ancestor with it below the
 * filesystem root; otherwise absolute. Non-absolute paths are returned
 * unchanged.
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

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

/**
 * The form of `path` an author can open from `cwd`: relative to `cwd` when
 * the two share an ancestor below the filesystem root (so a sibling
 * directory reads `../other/manifest.yaml`), and absolute otherwise (a file
 * under `/home` seen from `/tmp`, or another Windows drive). A path that is
 * not absolute is returned unchanged; callers resolve repo-relative names
 * first.
 */
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const target = normalize(path);
  const base = normalize(cwd);
  const targetRoot = parse(target).root;
  const baseRoot = parse(base).root;
  const sameRoot = SEPARATOR === "\\"
    ? targetRoot.toLowerCase() === baseRoot.toLowerCase()
    : targetRoot === baseRoot;
  if (!sameRoot) return target;
  const baseTop = topSegment(base, baseRoot);
  if (baseTop !== "" && topSegment(target, targetRoot) !== baseTop) {
    return target;
  }
  return relative(base, target) || ".";
}

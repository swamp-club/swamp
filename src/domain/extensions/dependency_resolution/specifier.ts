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

import { tryParseRange } from "@std/semver";

/**
 * bare means only a project config resolves it: everything but relative paths,
 * npm:, jsr:, http(s): and node: counts, so file:, absolute paths and data: are
 * bare too
 */
export function isBareSpecifier(specifier: string): boolean {
  // a ${...} placeholder is interpolated at runtime, not a package name; double
  // quotes do not interpolate, so this is valid at top level
  if (specifier.includes("${")) return false;
  if (specifier.startsWith(".")) return false;
  if (specifier.startsWith("npm:")) return false;
  if (specifier.startsWith("jsr:")) return false;
  if (specifier.startsWith("https:")) return false;
  if (specifier.startsWith("http:")) return false;
  if (specifier.startsWith("node:")) return false;
  return true;
}

/** JSR has no dist-tags, so Deno cannot resolve one */
export function jsrDistTag(specifier: string): string | undefined {
  const match = /^jsr:\/?@[^/@]+\/[^/@]+@([^/]+)/.exec(specifier);
  const version = match?.[1];
  if (!version) return undefined;
  return tryParseRange(version) === undefined ? version : undefined;
}

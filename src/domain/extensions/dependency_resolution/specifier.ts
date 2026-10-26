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
 * How an import specifier is spelled: the one classifier push, quality, fmt
 * and the loader read specifiers with (swamp-club#3969). An `npm:` or
 * `jsr:` specifier's package is read by the shared scorer's
 * `parseSpecifier` (`@swamp-club/extension-scoring/dependency-audit`), as
 * the registry reads it.
 */

/**
 * Whether a specifier is bare: one only a project config (an import map, a
 * package.json) resolves. Everything but a relative path, `npm:`, `jsr:`,
 * `http(s):` and `node:` counts, so `file:`, an absolute path and `data:`
 * are bare too, as push has always read them.
 *
 * The bundler resolves every other kind without a config: a relative path
 * by path, `npm:`, `jsr:` and URLs by fetching and inlining, and `node:` by
 * passing it through.
 */
export function isBareSpecifier(specifier: string): boolean {
  // A specifier carrying a `${...}` placeholder is interpolated at runtime, not
  // a package name: `import x from "${pkg}"` is valid TypeScript at the top
  // level, since double quotes do not interpolate.
  if (specifier.includes("${")) return false;
  if (specifier.startsWith(".")) return false;
  if (specifier.startsWith("npm:")) return false;
  if (specifier.startsWith("jsr:")) return false;
  if (specifier.startsWith("https:")) return false;
  if (specifier.startsWith("http:")) return false;
  if (specifier.startsWith("node:")) return false;
  return true;
}

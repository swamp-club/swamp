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
 * Gitignore-style pattern matcher for datastore exclude patterns.
 *
 * Supports:
 * - `*` matches anything except `/`
 * - `**` matches everything including `/`
 * - `?` matches any single character except `/`
 * - `[...]` character classes
 * - `!` prefix negates a pattern (re-includes previously excluded files)
 * - Patterns are evaluated top-to-bottom, later patterns override earlier ones
 */

/**
 * Converts a gitignore-style glob pattern to a RegExp.
 *
 * @param pattern - The glob pattern (without `!` prefix)
 * @returns A RegExp that matches the pattern
 */
export function globToRegExp(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches everything including /
        if (pattern[i + 2] === "/") {
          // **/ matches zero or more directories
          regexStr += "(?:.+/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        regexStr += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (char === "[") {
      // Character class - pass through until closing ]
      const closeBracket = pattern.indexOf("]", i + 1);
      if (closeBracket === -1) {
        // No closing bracket, treat as literal
        regexStr += "\\[";
        i++;
      } else {
        regexStr += pattern.slice(i, closeBracket + 1);
        i = closeBracket + 1;
      }
    } else if (
      char === "." || char === "+" || char === "^" || char === "$" ||
      char === "{" || char === "}" || char === "(" || char === ")" ||
      char === "|" || char === "\\"
    ) {
      // Escape regex special characters
      regexStr += "\\" + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  return new RegExp("^" + regexStr + "$");
}

interface CompiledPattern {
  regex: RegExp;
  negated: boolean;
}

/**
 * Compiles an array of gitignore-style patterns into optimized matchers.
 */
export function compilePatterns(patterns: string[]): CompiledPattern[] {
  return patterns
    .filter((p) => p.trim() !== "" && !p.startsWith("#"))
    .map((pattern) => {
      const trimmed = pattern.trim();
      const negated = trimmed.startsWith("!");
      const glob = negated ? trimmed.slice(1) : trimmed;
      return { regex: globToRegExp(glob), negated };
    });
}

/**
 * Checks if a relative path is excluded by the given patterns.
 *
 * Patterns are evaluated top-to-bottom. A `!` prefix negates (re-includes)
 * a previously excluded path. The last matching pattern wins.
 *
 * @param relativePath - Path relative to the datastore root (e.g., "telemetry/data.json")
 * @param excludePatterns - Array of gitignore-style patterns
 * @returns true if the path should be excluded from the datastore
 */
export function isExcluded(
  relativePath: string,
  excludePatterns: string[],
): boolean {
  const compiled = compilePatterns(excludePatterns);
  return isExcludedCompiled(relativePath, compiled);
}

/**
 * Checks exclusion using pre-compiled patterns for better performance
 * when checking many paths against the same pattern set.
 */
export function isExcludedCompiled(
  relativePath: string,
  compiled: CompiledPattern[],
): boolean {
  // Normalize: remove leading slash
  const normalized = relativePath.startsWith("/")
    ? relativePath.slice(1)
    : relativePath;

  let excluded = false;

  for (const { regex, negated } of compiled) {
    if (regex.test(normalized)) {
      excluded = !negated;
    }
  }

  return excluded;
}

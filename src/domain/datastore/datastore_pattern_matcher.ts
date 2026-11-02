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
 * patterns are evaluated top to bottom, later ones override earlier ones, and a
 * ! prefix re-includes files an earlier pattern excluded
 */

export function globToRegExp(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.+/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        regexStr += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (char === "[") {
      const closeBracket = pattern.indexOf("]", i + 1);
      if (closeBracket === -1) {
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

export function isExcluded(
  relativePath: string,
  excludePatterns: string[],
): boolean {
  const compiled = compilePatterns(excludePatterns);
  return isExcludedCompiled(relativePath, compiled);
}

export function isExcludedCompiled(
  relativePath: string,
  compiled: CompiledPattern[],
): boolean {
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

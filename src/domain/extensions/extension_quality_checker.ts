// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/** A quality issue found during checking. */
export interface QualityIssue {
  check: "fmt" | "lint" | "dynamic-import";
  output: string;
}

/** Result of the quality check. */
export interface QualityCheckResult {
  passed: boolean;
  issues: QualityIssue[];
}

/**
 * Strips comments and string literals from a single line of code,
 * so that pattern matching only sees actual code tokens.
 */
export function stripCommentsAndStrings(line: string): string {
  let result = "";
  let i = 0;
  while (i < line.length) {
    // Single-line comment — rest of line is not code
    if (line[i] === "/" && i + 1 < line.length && line[i + 1] === "/") {
      break;
    }
    // Block comment opening — skip until closing or end of line
    if (line[i] === "/" && i + 1 < line.length && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    // String literal — skip contents
    if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
      const quote = line[i];
      i++;
      while (i < line.length && line[i] !== quote) {
        if (line[i] === "\\") i++;
        i++;
      }
      i++; // skip closing quote
      continue;
    }
    result += line[i];
    i++;
  }
  return result;
}

/**
 * Checks extension TypeScript files for formatting and lint issues.
 *
 * Runs `deno fmt --check --no-config` and `deno lint --no-config` on all
 * `.ts` files. Both checks run even if the first fails, so all issues
 * are reported in a single pass.
 *
 * @param files - All extension files (non-.ts files are filtered out)
 * @param denoPath - Path to the deno binary
 * @returns Quality check result with pass/fail and any issues
 */
export async function checkExtensionQuality(
  files: string[],
  denoPath: string,
): Promise<QualityCheckResult> {
  const tsFiles = files.filter((f) => f.endsWith(".ts"));
  if (tsFiles.length === 0) {
    return { passed: true, issues: [] };
  }

  const issues: QualityIssue[] = [];

  // Check for dynamic imports — these break CJS/ESM interop when bundled
  const dynamicImportPattern = /\bimport\s*\(/;
  for (const file of tsFiles) {
    const content = await Deno.readTextFile(file);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripCommentsAndStrings(lines[i]);
      if (dynamicImportPattern.test(stripped)) {
        issues.push({
          check: "dynamic-import",
          output:
            `${file}:${
              i + 1
            }: Dynamic import() is not supported in extensions. ` +
            `Use static top-level imports instead (e.g., import { x } from "npm:pkg"). ` +
            `Dynamic imports break CJS/ESM interop when bundled.`,
        });
      }
    }
  }

  // Check formatting
  const fmtCommand = new Deno.Command(denoPath, {
    args: ["fmt", "--check", "--no-config", ...tsFiles],
    stdout: "piped",
    stderr: "piped",
  });
  const fmtOutput = await fmtCommand.output();
  if (!fmtOutput.success) {
    const stderr = new TextDecoder().decode(fmtOutput.stderr);
    const stdout = new TextDecoder().decode(fmtOutput.stdout);
    issues.push({
      check: "fmt",
      output: (stderr + stdout).trim(),
    });
  }

  // Check linting
  const lintCommand = new Deno.Command(denoPath, {
    args: ["lint", "--no-config", ...tsFiles],
    stdout: "piped",
    stderr: "piped",
  });
  const lintOutput = await lintCommand.output();
  if (!lintOutput.success) {
    const stderr = new TextDecoder().decode(lintOutput.stderr);
    const stdout = new TextDecoder().decode(lintOutput.stdout);
    issues.push({
      check: "lint",
      output: (stderr + stdout).trim(),
    });
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

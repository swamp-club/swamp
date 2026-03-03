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
  check: "fmt" | "lint";
  output: string;
}

/** Result of the quality check. */
export interface QualityCheckResult {
  passed: boolean;
  issues: QualityIssue[];
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

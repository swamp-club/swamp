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

import { basename } from "@std/path";
import {
  extractLastUpgradeToVersion,
  extractModelVersion,
} from "./extension_content_extractor.ts";

/** A quality issue found during checking. */
export interface QualityIssue {
  check:
    | "fmt"
    | "lint"
    | "dynamic-import"
    | "version-drift"
    | "upgrade-chain"
    | "version-bump-upgrade";
  output: string;
}

export function qualityCheckLabel(check: QualityIssue["check"]): string {
  switch (check) {
    case "fmt":
      return "Formatting";
    case "lint":
      return "Lint";
    case "dynamic-import":
      return "Dynamic import";
    case "version-drift":
      return "Version drift";
    case "upgrade-chain":
      return "Upgrade chain";
    case "version-bump-upgrade":
      return "Version bump upgrade";
  }
}

/** Result of the quality check. */
export interface QualityCheckResult {
  passed: boolean;
  issues: QualityIssue[];
}

/**
 * Strips comments and string/template literals from source code,
 * preserving newlines so line numbers remain stable. Handles multi-line
 * block comments, template literal interpolation (`${...}`), and nested
 * template literals correctly.
 *
 * Returns a string with the same number of lines as the input, where
 * non-code regions are replaced with spaces (preserving line structure).
 */
export function stripCommentsAndStrings(source: string): string {
  const result: string[] = [];
  let i = 0;
  // Stack for tracking template literal nesting depth.
  // Each entry is a brace depth counter for the current `${}` expression.
  const templateStack: number[] = [];

  while (i < source.length) {
    // Inside a template expression (`${...}`), track brace depth
    if (templateStack.length > 0) {
      const depth = templateStack[templateStack.length - 1];

      if (source[i] === "}") {
        if (depth === 0) {
          // Closing the `${}` expression — back to template literal body
          result.push(" ");
          i++;
          templateStack.pop();
          // Now skip template body until next `${` or closing backtick
          i = skipTemplateBody(source, i, result, templateStack);
          continue;
        }
        // Nested brace inside the expression
        templateStack[templateStack.length - 1]--;
        result.push(" ");
        i++;
        continue;
      }

      if (source[i] === "{") {
        templateStack[templateStack.length - 1]++;
        result.push(" ");
        i++;
        continue;
      }

      // Inside a template expression, code is real — but we still need to
      // handle strings/comments/nested templates within the expression
    }

    // Single-line comment
    if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        result.push(" ");
        i++;
      }
      continue;
    }

    // Block comment
    if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "*") {
      result.push(" ", " ");
      i += 2;
      while (i < source.length) {
        if (
          source[i] === "*" && i + 1 < source.length &&
          source[i + 1] === "/"
        ) {
          result.push(" ", " ");
          i += 2;
          break;
        }
        // Preserve newlines for line number stability
        result.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    // Double-quoted string
    if (source[i] === '"') {
      result.push(" ");
      i++;
      while (i < source.length && source[i] !== '"' && source[i] !== "\n") {
        if (source[i] === "\\") {
          result.push(" ");
          i++;
        }
        if (i < source.length) {
          result.push(" ");
          i++;
        }
      }
      if (i < source.length && source[i] === '"') {
        result.push(" ");
        i++;
      }
      continue;
    }

    // Single-quoted string
    if (source[i] === "'") {
      result.push(" ");
      i++;
      while (i < source.length && source[i] !== "'" && source[i] !== "\n") {
        if (source[i] === "\\") {
          result.push(" ");
          i++;
        }
        if (i < source.length) {
          result.push(" ");
          i++;
        }
      }
      if (i < source.length && source[i] === "'") {
        result.push(" ");
        i++;
      }
      continue;
    }

    // Template literal
    if (source[i] === "`") {
      result.push(" ");
      i++;
      i = skipTemplateBody(source, i, result, templateStack);
      continue;
    }

    result.push(source[i]);
    i++;
  }

  return result.join("");
}

/**
 * Skips through a template literal body, blanking out literal text and
 * preserving newlines. Stops when the closing backtick is found or when
 * a `${` expression is entered (pushing onto templateStack).
 *
 * @returns The new index position after processing.
 */
function skipTemplateBody(
  source: string,
  i: number,
  result: string[],
  templateStack: number[],
): number {
  while (i < source.length) {
    // Escaped character
    if (source[i] === "\\") {
      result.push(" ");
      i++;
      if (i < source.length) {
        result.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    // Template expression — enter it
    if (
      source[i] === "$" && i + 1 < source.length &&
      source[i + 1] === "{"
    ) {
      result.push(" ", " ");
      i += 2;
      templateStack.push(0);
      return i;
    }
    // End of template literal
    if (source[i] === "`") {
      result.push(" ");
      i++;
      return i;
    }
    result.push(source[i] === "\n" ? "\n" : " ");
    i++;
  }
  return i;
}

/**
 * Checks extension TypeScript files for formatting and lint issues.
 *
 * Runs `deno fmt --check` and `deno lint` on all `.ts` files. When a
 * `denoConfigPath` is provided, uses `--config <path>` so the project's
 * own lint/fmt rules apply; otherwise uses `--no-config` for default rules.
 * Both checks run even if the first fails, so all issues are reported in
 * a single pass.
 *
 * @param files - All extension files (non-.ts files are filtered out)
 * @param denoPath - Path to the deno binary
 * @param denoConfigPath - Optional absolute path to a deno.json project config
 * @returns Quality check result with pass/fail and any issues
 */
export async function checkExtensionQuality(
  files: string[],
  denoPath: string,
  denoConfigPath?: string,
  denoEnv?: Record<string, string>,
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
    const strippedLines = stripCommentsAndStrings(content).split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (dynamicImportPattern.test(strippedLines[i])) {
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
  const baseEnv = denoEnv ?? Deno.env.toObject();
  const fmtCommand = new Deno.Command(denoPath, {
    args: denoConfigPath
      ? ["fmt", "--check", "--config", denoConfigPath, ...tsFiles]
      : ["fmt", "--check", "--no-config", ...tsFiles],
    stdout: "piped",
    stderr: "piped",
    env: { ...baseEnv, NO_COLOR: "1" },
  });
  const fmtOutput = await fmtCommand.output();
  if (!fmtOutput.success) {
    const stderr = new TextDecoder().decode(fmtOutput.stderr);
    const stdout = new TextDecoder().decode(fmtOutput.stdout);
    const output = (stderr + stdout).trim();
    issues.push({ check: "fmt", output });
  }

  // Check linting
  const lintCommand = new Deno.Command(denoPath, {
    args: denoConfigPath
      ? ["lint", "--config", denoConfigPath, ...tsFiles]
      : ["lint", "--no-config", ...tsFiles],
    stdout: "piped",
    stderr: "piped",
    env: { ...baseEnv, NO_COLOR: "1" },
  });
  const lintOutput = await lintCommand.output();
  if (!lintOutput.success) {
    const stderr = new TextDecoder().decode(lintOutput.stderr);
    const stdout = new TextDecoder().decode(lintOutput.stdout);
    const output = (stderr + stdout).trim();
    issues.push({ check: "lint", output });
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

/** Published model metadata from the registry. */
export interface PublishedModelVersion {
  fileName: string;
  version: string;
}

/** Published extension state from the registry. */
export interface PublishedExtensionState {
  manifestVersion: string;
  models: PublishedModelVersion[];
}

/**
 * Advisory check — warns on version drift but never blocks.
 *
 * Compares current model versions against the registry's last-published
 * version. Warns when a model version moved but the manifest version
 * did not.
 *
 * When no published state is available (first publish), tells the user
 * rather than silently skipping.
 */
export async function checkVersionConsistency(
  manifestVersion: string,
  modelFiles: string[],
  published?: PublishedExtensionState,
): Promise<QualityIssue[]> {
  if (modelFiles.length === 0) return [];

  if (!published) {
    return [{
      check: "version-drift",
      output: "unable to check for version drift — no previously published " +
        "version found in the registry (this is expected on first publish)",
    }];
  }

  const publishedByFile = new Map<string, string>();
  for (const m of published.models) {
    publishedByFile.set(m.fileName, m.version);
  }

  const issues: QualityIssue[] = [];
  let anyModelVersionBumped = false;

  for (const file of modelFiles) {
    let content: string;
    try {
      content = await Deno.readTextFile(file);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        issues.push({
          check: "version-drift",
          output: `${basename(file)}: could not read file: ${e}`,
        });
      }
      continue;
    }

    const modelVersion = extractModelVersion(content);
    if (!modelVersion) continue;

    const publishedVersion = publishedByFile.get(basename(file));
    if (!publishedVersion) continue;

    if (modelVersion !== publishedVersion) {
      anyModelVersionBumped = true;
    }
  }

  if (
    anyModelVersionBumped &&
    manifestVersion === published.manifestVersion
  ) {
    issues.push({
      check: "version-drift",
      output:
        `manifest version "${manifestVersion}" was not bumped but one or ` +
        `more model versions changed (bump the manifest version)`,
    });
  }

  return issues;
}

/**
 * Validates that each model file's upgrade chain terminates at its
 * declared version. Blocks push when upgrades are present but the last
 * toVersion does not match the model version. Files without upgrades
 * (new models) pass cleanly.
 */
export async function checkUpgradeChainConsistency(
  modelFiles: string[],
): Promise<QualityIssue[]> {
  const issues: QualityIssue[] = [];

  for (const file of modelFiles) {
    let content: string;
    try {
      content = await Deno.readTextFile(file);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        issues.push({
          check: "upgrade-chain",
          output: `${basename(file)}: could not read file: ${e}`,
        });
      }
      continue;
    }

    const modelVersion = extractModelVersion(content);
    if (!modelVersion) continue;

    const lastToVersion = extractLastUpgradeToVersion(content);
    if (!lastToVersion) continue;

    if (lastToVersion !== modelVersion) {
      issues.push({
        check: "upgrade-chain",
        output:
          `${
            basename(file)
          }: last upgrade toVersion "${lastToVersion}" does not match ` +
          `model version "${modelVersion}". The upgrade chain must terminate ` +
          `at the current version — add an upgrade entry for "${modelVersion}" ` +
          `or update the model version to match.`,
      });
    }
  }

  return issues;
}

/**
 * Checks for model files that have a version field but no upgrades array.
 * This catches the case where a version was bumped but no upgrade entry
 * was added — existing instances would be stranded at their old
 * typeVersion. Only meaningful when the extension version is being bumped
 * from a previously published baseline.
 */
export async function checkVersionBumpWithoutUpgrade(
  modelFiles: string[],
): Promise<QualityIssue[]> {
  const issues: QualityIssue[] = [];

  for (const file of modelFiles) {
    let content: string;
    try {
      content = await Deno.readTextFile(file);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        issues.push({
          check: "version-bump-upgrade",
          output: `${basename(file)}: could not read file: ${e}`,
        });
      }
      continue;
    }

    const modelVersion = extractModelVersion(content);
    if (!modelVersion) continue;

    const lastToVersion = extractLastUpgradeToVersion(content);
    if (lastToVersion !== null) continue;

    issues.push({
      check: "version-bump-upgrade",
      output: `${basename(file)}: model has version "${modelVersion}" but no ` +
        `upgrades array. Existing instances will not auto-migrate to this ` +
        `version. Add an upgrades entry (even a no-op) — see ` +
        `references/model/upgrades.md. If this model is new and has never ` +
        `been published, pass --skip-upgrade-check to acknowledge.`,
    });
  }

  return issues;
}

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
import type { RegistryCheckNotRunCause } from "./extension_publish_checks.ts";
import { plainDenoEnv } from "../runtime/deno_plain_env.ts";
import { readDenoConfig } from "./deno_config.ts";

export interface QualityIssue {
  check:
    | "fmt"
    | "lint"
    | "dynamic-import"
    | "version-drift"
    | "upgrade-chain"
    | "version-bump-upgrade";
  output: string;
  cause?: VersionDriftNotComparedCause;
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

export interface QualityCheckResult {
  passed: boolean;
  issues: QualityIssue[];
}

/**
 * blanks comments, strings and regexes with spaces, keeping length and newlines
 * so offsets and line numbers hold; a / opens a regex only where an operand is
 * expected, and a regex cannot span a line
 */
export function stripCommentsAndStrings(source: string): string {
  const result: string[] = [];
  let i = 0;
  const templateStack: number[] = [];
  let regexAllowed = true;
  let word = "";
  const afterTemplateBody = (depthBefore: number) => {
    regexAllowed = templateStack.length > depthBefore;
    word = "";
  };

  while (i < source.length) {
    if (templateStack.length > 0) {
      const depth = templateStack[templateStack.length - 1];

      if (source[i] === "}") {
        if (depth === 0) {
          result.push(" ");
          i++;
          templateStack.pop();
          const depthBefore = templateStack.length;
          i = skipTemplateBody(source, i, result, templateStack);
          afterTemplateBody(depthBefore);
          continue;
        }
        templateStack[templateStack.length - 1]--;
        result.push(" ");
        i++;
        regexAllowed = false;
        word = "";
        continue;
      }

      if (source[i] === "{") {
        templateStack[templateStack.length - 1]++;
        result.push(" ");
        i++;
        regexAllowed = true;
        word = "";
        continue;
      }
    }

    if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "/") {
      result.push(" ", " ");
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        result.push(" ");
        i++;
      }
      continue;
    }

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
        result.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

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
      regexAllowed = false;
      word = "";
      continue;
    }

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
      regexAllowed = false;
      word = "";
      continue;
    }

    if (source[i] === "`") {
      result.push(" ");
      i++;
      const depthBefore = templateStack.length;
      i = skipTemplateBody(source, i, result, templateStack);
      afterTemplateBody(depthBefore);
      continue;
    }

    if (source[i] === "/" && regexAllowed) {
      const end = regexLiteralEnd(source, i);
      if (end !== -1) {
        for (; i < end; i++) result.push(" ");
        regexAllowed = false;
        word = "";
        continue;
      }
    }

    const ch = source[i];
    if (/[A-Za-z0-9_$]/.test(ch)) {
      word += ch;
      regexAllowed = REGEX_PRECEDING_KEYWORDS.has(word);
    } else if (/\s/.test(ch)) {
      word = "";
    } else {
      word = "";
      regexAllowed = !")]}".includes(ch);
    }
    result.push(ch);
    i++;
  }

  return result.join("");
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "of",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/**
 * index just past the regex, or -1 if the line ends first (not a regex); a /
 * inside a character class does not end it
 */
function regexLiteralEnd(source: string, start: number): number {
  let inClass = false;
  for (let j = start + 1; j < source.length; j++) {
    const c = source[j];
    if (c === "\n" || c === "\r") return -1;
    if (c === "\\") {
      j++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      return j + 1;
    }
  }
  return -1;
}

function skipTemplateBody(
  source: string,
  i: number,
  result: string[],
  templateStack: number[],
): number {
  while (i < source.length) {
    if (source[i] === "\\") {
      result.push(" ");
      i++;
      if (i < source.length) {
        result.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    if (
      source[i] === "$" && i + 1 < source.length &&
      source[i + 1] === "{"
    ) {
      result.push(" ", " ");
      i += 2;
      templateStack.push(0);
      return i;
    }
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

/** every caller (push, quality, fmt) uses this so they agree on the rules */
export function denoToolConfigArgs(denoConfigPath?: string): string[] {
  return denoConfigPath ? ["--config", denoConfigPath] : ["--no-config"];
}

/**
 * swamp requires explicit npm:/jsr: prefixes (the registry scorer cannot
 * resolve bare specifiers), which no-import-prefix forbids
 */
export const EXTENSION_LINT_RULE_EXCLUDES: readonly string[] = [
  "no-import-prefix",
];

/**
 * read as JSONC the way Deno reads it: [] when the config sets none, undefined
 * when the file cannot be read or parsed
 */
async function projectLintExcludes(
  denoConfigPath: string,
): Promise<string[] | undefined> {
  const config = await readDenoConfig(denoConfigPath);
  if (!config) return undefined;
  const lint = config.lint as { rules?: { exclude?: unknown } } | undefined;
  const exclude = lint?.rules?.exclude;
  return Array.isArray(exclude)
    ? exclude.filter((r): r is string => typeof r === "string")
    : [];
}

/**
 * --rules-exclude on the command line replaces the config's lint.rules.exclude,
 * so the project's own exclusions are passed along too; if the config is
 * unreadable no exclusion is passed
 */
export async function extensionLintArgs(
  denoConfigPath?: string,
): Promise<string[]> {
  const projectExcludes = denoConfigPath
    ? await projectLintExcludes(denoConfigPath)
    : [];
  if (projectExcludes === undefined) {
    return ["lint", ...denoToolConfigArgs(denoConfigPath)];
  }
  const excludes = [
    ...new Set([...projectExcludes, ...EXTENSION_LINT_RULE_EXCLUDES]),
  ];
  return [
    "lint",
    ...denoToolConfigArgs(denoConfigPath),
    `--rules-exclude=${excludes.join(",")}`,
  ];
}

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

  const plainEnv = plainDenoEnv(denoEnv ?? Deno.env.toObject());
  const fmtCommand = new Deno.Command(denoPath, {
    args: [
      "fmt",
      "--check",
      ...denoToolConfigArgs(denoConfigPath),
      ...tsFiles,
    ],
    stdout: "piped",
    stderr: "piped",
    env: plainEnv,
  });
  const fmtOutput = await fmtCommand.output();
  if (!fmtOutput.success) {
    const stderr = new TextDecoder().decode(fmtOutput.stderr);
    const stdout = new TextDecoder().decode(fmtOutput.stdout);
    const output = (stderr + stdout).trim();
    issues.push({ check: "fmt", output });
  }

  const lintCommand = new Deno.Command(denoPath, {
    args: [...(await extensionLintArgs(denoConfigPath)), ...tsFiles],
    stdout: "piped",
    stderr: "piped",
    env: plainEnv,
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

export interface PublishedModelVersion {
  fileName: string;
  version: string;
}

export interface PublishedExtensionState {
  manifestVersion: string;
  models: PublishedModelVersion[];
}

export type VersionDriftNotComparedCause =
  | "never-published"
  | Extract<
    RegistryCheckNotRunCause,
    "no-credentials" | "authentication-failed" | "registry-unavailable"
  >;

export type PublishedLookup =
  | { kind: "found"; state: PublishedExtensionState }
  | { kind: "never-published" }
  | { kind: "no-credentials" }
  | { kind: "authentication-failed"; reason: string }
  | { kind: "registry-unavailable"; reason: string };

const UPGRADE_CHECK_SKIPPED =
  "; the version-bump upgrade check was skipped too";

function withoutFinalPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

/**
 * advisory, never blocks; with nothing to compare it says why and records the
 * cause, so missing credentials or a failed lookup do not read as a first
 * publish
 */
export async function checkVersionConsistency(
  manifestVersion: string,
  modelFiles: string[],
  lookup: PublishedLookup,
): Promise<QualityIssue[]> {
  if (modelFiles.length === 0) return [];

  const notCompared = (
    cause: VersionDriftNotComparedCause,
    reason: string,
  ): QualityIssue[] => [{
    check: "version-drift",
    output: `unable to check for version drift — ${reason}`,
    cause,
  }];
  switch (lookup.kind) {
    case "never-published":
      return notCompared(
        "never-published",
        "no previously published version found in the registry " +
          "(this is expected on first publish)",
      );
    case "no-credentials":
      return notCompared(
        "no-credentials",
        "no credentials; run 'swamp auth login' to sign in" +
          UPGRADE_CHECK_SKIPPED,
      );
    case "authentication-failed":
      return notCompared(
        "authentication-failed",
        `authentication failed: ${
          withoutFinalPeriod(lookup.reason)
        }${UPGRADE_CHECK_SKIPPED}`,
      );
    case "registry-unavailable":
      return notCompared(
        "registry-unavailable",
        `registry lookup failed: ${
          withoutFinalPeriod(lookup.reason)
        }${UPGRADE_CHECK_SKIPPED}`,
      );
  }
  const published = lookup.state;

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
        `more behavior versions changed (bump the manifest version)`,
    });
  }

  return issues;
}

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
          `behavior version "${modelVersion}". The upgrade chain must terminate ` +
          `at the current version — add an upgrade entry for "${modelVersion}" ` +
          `or update the behavior version to match.`,
      });
    }
  }

  return issues;
}

/**
 * a bumped version with no upgrade entry strands existing instances at their
 * old typeVersion; only meaningful when bumping from a published baseline
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
      output:
        `${basename(file)}: behavior has version "${modelVersion}" but no ` +
        `upgrades array. Existing instances will not auto-migrate to this ` +
        `version. Add an upgrades entry (even a no-op) — see ` +
        `references/extension/references/model/upgrades.md. If this behavior ` +
        `is new and has never been published, pass --skip-upgrade-check ` +
        `to acknowledge.`,
    });
  }

  return issues;
}

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

import { basename, extname } from "@std/path";
import {
  type DenoCommandFinding,
  findDenoCommandUse,
} from "./deno_command_detector.ts";
import {
  type DynamicCodeFinding,
  findDynamicCodeExecution,
} from "./dynamic_code_detector.ts";
import {
  parseExtensionSource,
  parseExtensionSourceWithComments,
} from "./extension_source_ast.ts";
import {
  type BundleModule,
  BundleModuleMap,
  dependencyLabel,
} from "./bundle_module_map.ts";
import { escapeControlCharacters } from "../control_characters.ts";
import { remediationFor } from "./extension_rule_catalog.ts";
import { directiveSpans, withoutDirective } from "./extension_acceptances.ts";

export interface SafetyIssue {
  ruleId: string;
  file: string;
  /**
   * absent for file-level and extension-level issues; with file and ruleId it
   * is the identity a declared acceptance names
   */
  line?: number;
  message: string;
  remediation?: string;
}

export const SAFETY_WARNING_RULE_IDS = [
  "long-line",
  "base64-run",
  "deno-command",
] as const;

export const SAFETY_ERROR_RULE_IDS = [
  "file-count",
  "hidden-file",
  "file-type",
  "unreadable-file",
  "symlink",
  "file-size",
  "total-size",
  "dynamic-code",
] as const;

function issue(
  ruleId: string,
  file: string,
  message: string,
  line?: number,
): SafetyIssue {
  const remediation = remediationFor(ruleId);
  return {
    ruleId,
    file,
    ...(line !== undefined ? { line } : {}),
    message,
    ...(remediation !== undefined ? { remediation } : {}),
  };
}

/**
 * link is the file itself or a directory above it below the extension's root;
 * names the link, never its target
 */
export function symlinkIssue(file: string, link: string): SafetyIssue {
  return issue(
    "symlink",
    file,
    (link === file
      ? "Symlinks are not allowed in extensions."
      : `Symlinks are not allowed in extensions: ${link} is a symlink.`) +
      " Copy the file into the extension tree instead.",
  );
}

export interface ContentDetection {
  message: string;
  line?: number;
}

export interface SafetyCheckResult {
  errors: SafetyIssue[];
  warnings: SafetyIssue[];
}

export interface ContentRule {
  id: string;
  severity: "error" | "warning";
  fileExtensions: Set<string>;
  detect: (content: string, file: string) => Array<string | ContentDetection>;
}

const IPV4_PATTERN =
  /(?<![.\w])(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)(?![.\w])/g;

function isDocumentationIp(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) return true;
  if (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) return true;
  if (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) return true;
  if (octets[0] === 127) return true;
  if (octets.every((o) => o === 0)) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  return false;
}

export const DEFAULT_CONTENT_RULES: ContentRule[] = [
  {
    id: "ipv4-address-literals",
    severity: "warning",
    fileExtensions: new Set([".md", ".txt"]),
    detect: (content: string): ContentDetection[] => {
      // One detection per line so an acceptance can name the line; the
      // addresses on that line are listed in its message.
      const detections: ContentDetection[] = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const found: string[] = [];
        for (const match of lines[i].matchAll(IPV4_PATTERN)) {
          if (!isDocumentationIp(match[0])) {
            found.push(match[0]);
          }
        }
        if (found.length === 0) continue;
        const unique = [...new Set(found)];
        const listed = unique.length <= 3
          ? unique.join(", ")
          : `${unique.slice(0, 3).join(", ")}, and ${unique.length - 3} more`;
        detections.push({
          line: i + 1,
          message: `Line ${i + 1} contains IPv4 address literals (${listed}) ` +
            "that may be real infrastructure identifiers. Use RFC 5737 " +
            "documentation ranges (192.0.2.x, 198.51.100.x, 203.0.113.x) or " +
            "example.com for examples.",
        });
      }
      return detections;
    },
  },
];

export const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".txt",
]);

export const LEGAL_BASENAMES = new Set([
  "AUTHORS",
  "CONTRIBUTORS",
  "COPYING",
  "COPYING-EXCEPTION",
  "LICENSE",
  "NOTICE",
  "PATENTS",
]);

const MAX_FILE_COUNT = 150;
const MAX_INDIVIDUAL_FILE_SIZE = 1_000_000;
const MAX_TOTAL_SIZE = 10_000_000;
const LONG_LINE_THRESHOLD = 500;
const BASE64_PATTERN = /[A-Za-z0-9+/=]{100,}/;
const MAX_REPORTED_LOCATIONS = 5;

const DYNAMIC_CODE_LABELS: Record<DynamicCodeFinding["kind"], string> = {
  "eval-reference": "eval",
  "eval-computed-access": "computed eval/Function access",
  "function-constructor": "Function constructor",
  "constructor-call": ".constructor call",
  "eval-member": "member named eval or Function",
  "unparsed-eval-text":
    "eval( or new Function( text in a file that does not parse",
};

/**
 * a direct Deno.Command reference names the line in preference to an alias of
 * Deno
 */
function describeDenoCommand(
  line: number,
  findings: DenoCommandFinding[],
): string {
  const kinds = new Set(findings.map((f) => f.kind));
  if (kinds.has("command-reference") || kinds.has("unparsed-text")) {
    return `Line ${line} uses Deno.Command() to spawn subprocesses.`;
  }
  if (kinds.has("deno-computed-access")) {
    return `Line ${line} reads a computed key from Deno, which can reach ` +
      "Deno.Command() to spawn subprocesses.";
  }
  return `Line ${line} uses Deno as a value, which can reach ` +
    "Deno.Command() to spawn subprocesses.";
}

function describeDynamicCode(findings: DynamicCodeFinding[]): string {
  const shown = findings.slice(0, MAX_REPORTED_LOCATIONS).map((f) =>
    `line ${f.line}:${f.column} ${DYNAMIC_CODE_LABELS[f.kind]}`
  );
  const more = findings.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? `; and ${more} more` : ""}`;
}

export async function analyzeExtensionSafety(
  files: string[],
  exemptFromExtensionCheck?: Set<string>,
  contentRules: ContentRule[] = DEFAULT_CONTENT_RULES,
): Promise<SafetyCheckResult> {
  const errors: SafetyIssue[] = [];
  const warnings: SafetyIssue[] = [];

  if (files.length > MAX_FILE_COUNT) {
    errors.push(issue(
      "file-count",
      "(total)",
      `Extension contains ${files.length} files, exceeding the maximum of ${MAX_FILE_COUNT}.`,
    ));
  }

  let totalSize = 0;

  for (const file of files) {
    const name = basename(file);

    if (name.startsWith(".")) {
      errors.push(
        issue(
          "hidden-file",
          file,
          "Hidden files are not allowed in extensions.",
        ),
      );
      continue;
    }

    const ext = extname(file).toLowerCase();
    const isExempt = exemptFromExtensionCheck?.has(file) ?? false;
    if (
      !isExempt && !ALLOWED_EXTENSIONS.has(ext) && !LEGAL_BASENAMES.has(name)
    ) {
      errors.push(issue(
        "file-type",
        file,
        `File extension "${ext}" is not allowed. Allowed: ${
          [...ALLOWED_EXTENSIONS].join(", ")
        }`,
      ));
      continue;
    }

    let stat: Deno.FileInfo;
    try {
      stat = await Deno.lstat(file);
    } catch {
      errors.push(issue("unreadable-file", file, "File could not be read."));
      continue;
    }

    if (stat.isSymlink) {
      errors.push(symlinkIssue(file, file));
      continue;
    }

    if (stat.size > MAX_INDIVIDUAL_FILE_SIZE) {
      errors.push(issue(
        "file-size",
        file,
        `File size ${formatBytes(stat.size)} exceeds maximum of ${
          formatBytes(MAX_INDIVIDUAL_FILE_SIZE)
        }.`,
      ));
      continue;
    }

    totalSize += stat.size;

    if (ext === ".ts") {
      let content: string;
      try {
        content = await Deno.readTextFile(file);
      } catch {
        continue;
      }

      // Both code rules read one parse; a file that does not parse falls
      // back to each rule's text check.
      const program = parseExtensionSource(content, { path: file });

      const dynamicCode = findDynamicCodeExecution(content, program);
      if (dynamicCode.length > 0) {
        errors.push(issue(
          "dynamic-code",
          file,
          `File contains eval() or new Function() which are not allowed (${
            describeDynamicCode(dynamicCode)
          }).`,
          dynamicCode[0].line,
        ));
      }

      // Warnings: suspicious patterns. One finding per offending line, so a
      // declared acceptance can name the line and a new hit elsewhere still
      // warns.
      const denoCommandByLine = new Map<number, DenoCommandFinding[]>();
      for (const finding of findDenoCommandUse(content, program)) {
        const onLine = denoCommandByLine.get(finding.line) ?? [];
        onLine.push(finding);
        denoCommandByLine.set(finding.line, onLine);
      }
      const lines = content.split("\n");
      const spans = directiveSpans(content, file);
      for (let i = 0; i < lines.length; i++) {
        // Long-line and base64 scan the line as written so nothing hides behind
        // a directive; only the long-line count discounts directive text.
        // deno-command reads the tree, using text only when the file does not
        // parse
        const line = lines[i];
        const stripped = withoutDirective(line, spans.get(i + 1))
          .replace(/\s/g, "");
        if (stripped.length > LONG_LINE_THRESHOLD) {
          warnings.push(issue(
            "long-line",
            file,
            `Line ${i + 1} has ${stripped.length} non-whitespace characters ` +
              `(limit ${LONG_LINE_THRESHOLD}).`,
            i + 1,
          ));
        }
        if (BASE64_PATTERN.test(line)) {
          warnings.push(issue(
            "base64-run",
            file,
            `Line ${
              i + 1
            } contains what appears to be a base64-encoded string (100+ chars).`,
            i + 1,
          ));
        }
        const denoCommand = denoCommandByLine.get(i + 1);
        if (denoCommand) {
          warnings.push(issue(
            "deno-command",
            file,
            describeDenoCommand(i + 1, denoCommand),
            i + 1,
          ));
        }
      }
    }

    if (ext !== ".ts") {
      const matchingRules = contentRules.filter((r) =>
        r.fileExtensions.has(ext)
      );
      if (matchingRules.length > 0) {
        let content: string;
        try {
          content = await Deno.readTextFile(file);
        } catch {
          continue;
        }
        // a Markdown directive's own text is skipped since its reason may quote
        // an address; inside a fenced code block it is documentation, not a
        // directive, so it is scanned as written
        const spans = directiveSpans(content, file);
        const scanned = content.split("\n").map((l, i) =>
          withoutDirective(l, spans.get(i + 1))
        ).join("\n");
        for (const rule of matchingRules) {
          for (const detected of rule.detect(scanned, file)) {
            const detection: ContentDetection = typeof detected === "string"
              ? { message: detected }
              : detected;
            const found = issue(
              rule.id,
              file,
              detection.message,
              detection.line,
            );
            if (rule.severity === "error") {
              errors.push(found);
            } else {
              warnings.push(found);
            }
          }
        }
      }
    }
  }

  if (totalSize > MAX_TOTAL_SIZE) {
    errors.push(issue(
      "total-size",
      "(total)",
      `Total extension size ${formatBytes(totalSize)} exceeds maximum of ${
        formatBytes(MAX_TOTAL_SIZE)
      }.`,
    ));
  }

  return { errors, warnings };
}

export interface BundleDependencyIssue {
  dependency: string;
  issue: SafetyIssue;
}

export interface BundleSafetyResult {
  /**
   * Findings in the extension's own modules, above the first module
   * comment, or in a bundle without module comments: one per module.
   */
  errors: SafetyIssue[];
  dependencyIssues: BundleDependencyIssue[];
}

/**
 * Whether a bundle module's findings are a dependency's: its comment names a
 * dependency path, and this machine does not know the path to be the
 * extension's own.
 */
function isDependencyCode(
  module: BundleModule,
  isExtensionModule: ((path: string) => boolean) | undefined,
): boolean {
  if (module.origin !== "dependency" || module.path === undefined) return false;
  return isExtensionModule?.(module.path) !== true;
}

const MAX_PRINTED_MODULE_PATH = 200;

/**
 * A module path from a bundle comment, safe to print: control characters
 * escaped and the length capped, since whoever built the bundle wrote it.
 */
function printableModulePath(path: string): string {
  const escaped = escapeControlCharacters(path);
  return escaped.length > MAX_PRINTED_MODULE_PATH
    ? `${escaped.slice(0, MAX_PRINTED_MODULE_PATH)}...`
    : escaped;
}

/**
 * own-module findings, those above the first module comment, and all findings
 * in a bundle without module comments are errors; dependency-module findings
 * are reported, not refused
 */
export function analyzeBundleSafety(
  source: string,
  bundleFile: string,
  options: { isExtensionModule?: (path: string) => boolean } = {},
): BundleSafetyResult {
  const parsed = parseExtensionSourceWithComments(source, {
    path: bundleFile,
  });
  const findings = findDynamicCodeExecution(source, parsed?.program ?? null);
  if (findings.length === 0) return { errors: [], dependencyIssues: [] };
  // Without a parse, module comments cannot be told from text in a string.
  // A bundle built here may only be attributed through real comments, so an
  // unparsed one counts as the extension's own throughout.
  const modules = parsed
    ? BundleModuleMap.fromComments(source, parsed.comments)
    : options.isExtensionModule
    ? BundleModuleMap.fromText("")
    : BundleModuleMap.fromText(source);

  const groups = new Map<
    string,
    { path?: string; dependency: boolean; findings: DynamicCodeFinding[] }
  >();
  for (const finding of findings) {
    const module = modules.moduleAt(finding.line);
    const dependency = isDependencyCode(module, options.isExtensionModule);
    const key = `${dependency}\0${module.origin}\0${module.path ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { path: module.path, dependency, findings: [] };
      groups.set(key, group);
    }
    group.findings.push(finding);
  }

  const errors: SafetyIssue[] = [];
  const dependencyIssues: BundleDependencyIssue[] = [];
  for (const group of groups.values()) {
    const what = `eval() or new Function() (${
      describeDynamicCode(group.findings)
    })`;
    const line = group.findings[0].line;
    if (group.dependency && group.path !== undefined) {
      const dependency = printableModulePath(dependencyLabel(group.path));
      dependencyIssues.push({
        dependency,
        issue: issue(
          "dynamic-code",
          bundleFile,
          `Dependency ${dependency} uses ${what}. Findings in dependency ` +
            "code are reported, not refused.",
          line,
        ),
      });
      continue;
    }
    const where = group.path !== undefined
      ? `Module ${printableModulePath(group.path)}`
      : modules.moduleCount > 0
      ? "Code above the bundle's first module"
      : parsed
      ? "The bundle has no module comments, so all of its code is treated " +
        "as the extension's own. It"
      : "The bundle does not parse, so all of its code is treated as the " +
        "extension's own. It";
    errors.push(issue(
      "dynamic-code",
      bundleFile,
      `${where} contains ${what}, which are not allowed.`,
      line,
    ));
  }
  return { errors, dependencyIssues };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

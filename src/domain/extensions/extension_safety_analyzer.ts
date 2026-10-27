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

/** A safety issue found during analysis. */
export interface SafetyIssue {
  /** The rule that produced the issue; listed in the rule catalog. */
  ruleId: string;
  file: string;
  /**
   * The 1-based line the issue is on. Absent for file-level issues (a
   * hidden file, a size cap) and extension-level ones (file count, total
   * size). Together with `file` and `ruleId` it is the identity a declared
   * acceptance names.
   */
  line?: number;
  message: string;
  /** How to fix the issue properly, from the rule catalog. */
  remediation?: string;
}

/** Rule ids of the warnings the analyzer emits on `.ts` files. */
export const SAFETY_WARNING_RULE_IDS = [
  "long-line",
  "base64-run",
  "deno-command",
] as const;

/** Rule ids of the errors the analyzer emits. */
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

/** Builds an issue, attaching the catalog's remediation when the rule has one. */
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
 * The symlink-rule error for `file`, whose path has the symlink `link` on
 * it: the file itself, or a directory above it below the extension's root
 * (swamp-club#3421). Names the link, never its target.
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

/** A detection a content rule reports: its message, and the line when it has one. */
export interface ContentDetection {
  message: string;
  /** 1-based line of the match; omitted for file-level findings. */
  line?: number;
}

/** Result of the safety analysis. */
export interface SafetyCheckResult {
  /** Hard errors that block the push. */
  errors: SafetyIssue[];
  /** Warnings that prompt the user but don't block. */
  warnings: SafetyIssue[];
}

// ── Content rule framework ───────────────────────────────────────────

/**
 * A pluggable content hygiene rule for non-code files. Each rule declares
 * which file extensions it inspects and a pure detect function that returns
 * one message per issue found. Append new rules to
 * {@link DEFAULT_CONTENT_RULES} to grow the enforced set.
 */
export interface ContentRule {
  /** Stable identifier, e.g. `ipv4-address-literals`. */
  id: string;
  /** Whether findings block the push (`"error"`) or only warn (`"warning"`). */
  severity: "error" | "warning";
  /** File extensions this rule inspects, e.g. `new Set([".md", ".txt"])`. */
  fileExtensions: Set<string>;
  /**
   * Returns one entry per issue found (a bare message, or a
   * {@link ContentDetection} carrying the line); empty array means the file
   * passes.
   */
  detect: (content: string, file: string) => Array<string | ContentDetection>;
}

// ── IPv4 detection helpers ───────────────────────────────────────────

const IPV4_PATTERN =
  /(?<![.\w])(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)(?![.\w])/g;

function isDocumentationIp(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  // RFC 5737 documentation ranges
  if (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) return true;
  if (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) return true;
  if (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) return true;
  // Loopback (127.x.x.x)
  if (octets[0] === 127) return true;
  // Unspecified (0.0.0.0)
  if (octets.every((o) => o === 0)) return true;
  // Link-local (169.254.x.x)
  if (octets[0] === 169 && octets[1] === 254) return true;
  return false;
}

// ── Default content rules ────────────────────────────────────────────

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

// ── Constants ────────────────────────────────────────────────────────

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
const MAX_INDIVIDUAL_FILE_SIZE = 1_000_000; // 1 MB
const MAX_TOTAL_SIZE = 10_000_000; // 10 MB
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
 * The `deno-command` message for a line, from the findings on it. A direct
 * `Deno.Command` reference names the line over an alias of `Deno`.
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

/**
 * Analyzes files to be bundled for safety issues.
 *
 * Hard errors block the push; warnings prompt the user.
 *
 * @param files - Absolute paths of all files to include in the extension
 * @returns Safety check result with errors and warnings
 */
export async function analyzeExtensionSafety(
  files: string[],
  exemptFromExtensionCheck?: Set<string>,
  contentRules: ContentRule[] = DEFAULT_CONTENT_RULES,
): Promise<SafetyCheckResult> {
  const errors: SafetyIssue[] = [];
  const warnings: SafetyIssue[] = [];

  // Check file count
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

    // Check for hidden files
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

    // Check allowed extensions (exempt files and legal basenames skip this check)
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

    // Check for symlinks
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

    // Check individual file size
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

    // Content checks for .ts files
    if (ext === ".ts") {
      let content: string;
      try {
        content = await Deno.readTextFile(file);
      } catch {
        continue;
      }

      // Both code rules read one parse; a file that does not parse falls
      // back to each rule's text check.
      const program = parseExtensionSource(content);

      // Hard errors: dangerous patterns
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
        // The long-line and base64 checks scan the line as written, so
        // nothing can hide behind a directive (a directive's reason may not
        // carry Deno.Command( or a base64 run, so it cannot trigger these
        // rules). Only the long-line count discounts the directive's own
        // text. deno-command reads the syntax tree, where a directive is a
        // comment; only its text fallback, for a file that does not parse,
        // scans the line as written.
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

    // Content rules for non-.ts files
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
        // As for `.ts` lines: a Markdown directive's own text (its reason
        // may quote an address) must not trigger the rule it accepts. Inside
        // a fenced code block a directive is documentation, not parsed, so
        // its text is scanned as written.
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

  // Check total size
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

/** A dependency module's dynamic-code findings in one bundle. */
export interface BundleDependencyIssue {
  /** The dependency module, as {@link dependencyLabel} names it, printable. */
  dependency: string;
  /** The warning, its file being the bundle. */
  issue: SafetyIssue;
}

/** What {@link analyzeBundleSafety} found in one bundle. */
export interface BundleSafetyResult {
  /**
   * Findings in the extension's own modules, above the first module
   * comment, or in a bundle without module comments: one per module.
   */
  errors: SafetyIssue[];
  /** Findings in dependency modules: one per module, not blocking. */
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

/** The longest module path a bundle finding prints. */
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
 * Runs the dynamic-code rule, the one hard-error rule that reads content,
 * over a bundle, and attributes each finding to the module it is in through
 * the module comments `deno bundle` writes. The file rules (type, size,
 * count) are for sources and do not apply to a bundle.
 *
 * Findings in the extension's own modules are errors. So are findings above
 * the first module comment and, in a bundle without module comments, every
 * finding: that code cannot be shown to be a dependency's. Findings in a
 * dependency module are reported, not refused.
 *
 * @param source - The bundle's text
 * @param bundleFile - How to name the bundle in findings, e.g. `bundles/foo.js`
 * @param options.isExtensionModule - Says a module path is the extension's
 *   own even where it reads like a dependency's. A bundle built on this
 *   machine knows where the extension is installed; a module there under a
 *   `node_modules` directory is still the extension's code. Given only for
 *   such a bundle, which is then attributed through parsed comments alone.
 */
export function analyzeBundleSafety(
  source: string,
  bundleFile: string,
  options: { isExtensionModule?: (path: string) => boolean } = {},
): BundleSafetyResult {
  const parsed = parseExtensionSourceWithComments(source);
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

  // Grouped by module, in the order each module's first finding appears.
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

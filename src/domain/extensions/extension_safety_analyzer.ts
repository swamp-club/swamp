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
  type DynamicCodeFinding,
  findDynamicCodeExecution,
} from "./dynamic_code_detector.ts";
import { remediationFor } from "./extension_rule_catalog.ts";
import { withoutDirective } from "./extension_acceptances.ts";

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
      errors.push(
        issue("symlink", file, "Symlinks are not allowed in extensions."),
      );
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

      // Hard errors: dangerous patterns
      const dynamicCode = findDynamicCodeExecution(content);
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
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        // Drop exactly the acceptance directive the parser recognises (a
        // real comment, never text inside a string literal), so a directive
        // never triggers the rule it accepts and nothing else is hidden.
        const line = withoutDirective(lines[i], file);
        const stripped = line.replace(/\s/g, "");
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
        if (line.includes("Deno.Command(")) {
          warnings.push(issue(
            "deno-command",
            file,
            `Line ${i + 1} uses Deno.Command() to spawn subprocesses.`,
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
        // may quote an address) must not trigger the rule it accepts.
        const scanned = content.split("\n").map((l) =>
          withoutDirective(l, file)
        )
          .join("\n");
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

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

/** A safety issue found during analysis. */
export interface SafetyIssue {
  file: string;
  message: string;
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
  /** Returns one message per issue found; empty array means the file passes. */
  detect: (content: string, file: string) => string[];
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
    detect: (content: string): string[] => {
      const found: string[] = [];
      for (const match of content.matchAll(IPV4_PATTERN)) {
        if (!isDocumentationIp(match[0])) {
          found.push(match[0]);
        }
      }
      if (found.length === 0) return [];
      const unique = [...new Set(found)];
      const listed = unique.length <= 3
        ? unique.join(", ")
        : `${unique.slice(0, 3).join(", ")}, and ${unique.length - 3} more`;
      return [
        `Contains IPv4 address literals (${listed}) that may be real ` +
        "infrastructure identifiers. Use RFC 5737 documentation ranges " +
        "(192.0.2.x, 198.51.100.x, 203.0.113.x) or example.com for examples.",
      ];
    },
  },
];

// ── Constants ────────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".txt",
]);

const MAX_FILE_COUNT = 150;
const MAX_INDIVIDUAL_FILE_SIZE = 1_000_000; // 1 MB
const MAX_TOTAL_SIZE = 10_000_000; // 10 MB
const LONG_LINE_THRESHOLD = 500;
const BASE64_PATTERN = /[A-Za-z0-9+/=]{100,}/;

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
    errors.push({
      file: "(total)",
      message:
        `Extension contains ${files.length} files, exceeding the maximum of ${MAX_FILE_COUNT}.`,
    });
  }

  let totalSize = 0;

  for (const file of files) {
    const name = basename(file);

    // Check for hidden files
    if (name.startsWith(".")) {
      errors.push({
        file,
        message: "Hidden files are not allowed in extensions.",
      });
      continue;
    }

    // Check allowed extensions (exempt files skip this check)
    const ext = extname(file).toLowerCase();
    const isExempt = exemptFromExtensionCheck?.has(file) ?? false;
    if (!isExempt && !ALLOWED_EXTENSIONS.has(ext)) {
      errors.push({
        file,
        message: `File extension "${ext}" is not allowed. Allowed: ${
          [...ALLOWED_EXTENSIONS].join(", ")
        }`,
      });
      continue;
    }

    // Check for symlinks
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.lstat(file);
    } catch {
      errors.push({
        file,
        message: "File could not be read.",
      });
      continue;
    }

    if (stat.isSymlink) {
      errors.push({
        file,
        message: "Symlinks are not allowed in extensions.",
      });
      continue;
    }

    // Check individual file size
    if (stat.size > MAX_INDIVIDUAL_FILE_SIZE) {
      errors.push({
        file,
        message: `File size ${formatBytes(stat.size)} exceeds maximum of ${
          formatBytes(MAX_INDIVIDUAL_FILE_SIZE)
        }.`,
      });
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
      if (content.includes("eval(") || content.includes("new Function(")) {
        errors.push({
          file,
          message:
            "File contains eval() or new Function() which are not allowed.",
        });
      }

      // Warnings: suspicious patterns
      const lines = content.split("\n");
      for (const line of lines) {
        const stripped = line.replace(/\s/g, "");
        if (stripped.length > LONG_LINE_THRESHOLD) {
          warnings.push({
            file,
            message:
              "File contains lines with more than 500 non-whitespace characters.",
          });
          break; // One warning per file
        }
      }

      if (BASE64_PATTERN.test(content)) {
        warnings.push({
          file,
          message:
            "File contains what appears to be a base64-encoded string (100+ chars).",
        });
      }

      if (content.includes("Deno.Command(")) {
        warnings.push({
          file,
          message: "File uses Deno.Command() to spawn subprocesses.",
        });
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
        for (const rule of matchingRules) {
          for (const message of rule.detect(content, file)) {
            const issue: SafetyIssue = { file, message };
            if (rule.severity === "error") {
              errors.push(issue);
            } else {
              warnings.push(issue);
            }
          }
        }
      }
    }
  }

  // Check total size
  if (totalSize > MAX_TOTAL_SIZE) {
    errors.push({
      file: "(total)",
      message: `Total extension size ${
        formatBytes(totalSize)
      } exceeds maximum of ${formatBytes(MAX_TOTAL_SIZE)}.`,
    });
  }

  return { errors, warnings };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

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

import type { Logger } from "@logtape/logtape";
import { escapeLogTemplate } from "../../infrastructure/logging/logger.ts";
import {
  acceptanceSnippet,
  fileRelativeToManifest,
} from "../../domain/extensions/extension_acceptances.ts";
import type { ReviewFinding } from "../../domain/extensions/extension_review_rules.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import type { DeclaredAcceptances } from "../../libswamp/extensions/push.ts";

/**
 * The findings report that closes a push summary, a dry run and a quality
 * run: what the author already accepted, with reasons, and what is left for
 * next time, each with how to fix it properly and, when the finding is not
 * right for this extension, the exact acceptance to paste. Built from the
 * gated warnings themselves, not from the flag waiver record, so a `--json`
 * run, a dry run and an interactive "y" all get it.
 */

/** One unaccepted warning, as advice. */
export interface ForNextTimeEntry {
  ruleId: string;
  /** Relative to the manifest's directory with forward slashes; a label such as `(multiple files)` passes through. */
  file: string;
  line?: number;
  message: string;
  /** How to fix the finding properly, from the rule catalog. */
  remediation?: string;
  /** The exact text to paste to accept the finding; absent when the rule has no acceptance form. */
  acceptance?: string;
  /** Where the acceptance goes, in words; present with `acceptance`. */
  placement?: string;
}

/** The two blocks, each present only when it has entries. */
export interface FindingsReport {
  declaredAcceptances?: DeclaredAcceptances;
  forNextTime?: ForNextTimeEntry[];
}

/** The findings a run gates on, after acceptances. */
export interface GatedFindings {
  safetyWarnings: SafetyIssue[];
  reviewWarnings: ReviewFinding[];
  acceptances: DeclaredAcceptances;
}

/** A finding with its paste-ready acceptance attached, for the JSON warnings documents. */
export type WithAcceptance<T> = T & { acceptance?: string };

/** Attaches the paste-ready acceptance to each finding that has one. */
export function withAcceptance<T extends SafetyIssue | ReviewFinding>(
  findings: T[],
  manifestDir: string,
  repoDir?: string,
): WithAcceptance<T>[] {
  return findings.map((finding) => {
    const snippet = acceptanceSnippet(finding, manifestDir, repoDir);
    return snippet ? { ...finding, acceptance: snippet.text } : finding;
  });
}

function forNextTimeEntry(
  finding: SafetyIssue | ReviewFinding,
  manifestDir: string,
  repoDir?: string,
): ForNextTimeEntry {
  const snippet = acceptanceSnippet(finding, manifestDir, repoDir);
  return {
    ruleId: finding.ruleId,
    file: fileRelativeToManifest(manifestDir, finding.file, repoDir),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    message: finding.message.split("\n")[0],
    ...(finding.remediation !== undefined
      ? { remediation: finding.remediation }
      : {}),
    ...(snippet
      ? { acceptance: snippet.text, placement: snippet.placement }
      : {}),
  };
}

/**
 * Builds the report. A collapsed testing-completeness finding expands to one
 * entry per remaining file, so each has its own paste-ready header comment.
 */
export function buildFindingsReport(
  findings: GatedFindings,
  manifestDir: string,
  repoDir?: string,
): FindingsReport {
  const forNextTime: ForNextTimeEntry[] = [];
  for (const w of findings.safetyWarnings) {
    forNextTime.push(forNextTimeEntry(w, manifestDir, repoDir));
  }
  for (const w of findings.reviewWarnings) {
    if (w.files && w.files.length > 0) {
      // One entry per file the collapsed finding stands for, each with the
      // per-file wording so the advice reads per file.
      for (const file of w.files) {
        forNextTime.push(forNextTimeEntry(
          {
            ...w,
            file,
            message: "No sibling `_test.ts` found — cover both success and " +
              "failure paths with unit tests before publishing.",
          },
          manifestDir,
          repoDir,
        ));
      }
    } else {
      forNextTime.push(forNextTimeEntry(w, manifestDir, repoDir));
    }
  }
  const hasAcceptances = findings.acceptances.accepted.length > 0 ||
    findings.acceptances.generated !== undefined;
  return {
    ...(hasAcceptances ? { declaredAcceptances: findings.acceptances } : {}),
    ...(forNextTime.length > 0 ? { forNextTime } : {}),
  };
}

/** The log-mode header strings, anchored by tests and UAT. */
export const ACCEPTED_HEADER = "Accepted, with reasons:";
export const FOR_NEXT_TIME_HEADER = "For next time:";

/**
 * Prints the two blocks in log mode, each only when it has entries. Every
 * line is escaped before it reaches LogTape: a plain string is a message
 * template there, and messages, remediation and reasons carry braces
 * (`.meta({ sensitive: true })`, `z.object({})`).
 */
export function renderFindingsReport(
  logger: Logger,
  report: FindingsReport,
): void {
  const line = (text: string) => logger.info(escapeLogTemplate(text));
  if (report.declaredAcceptances) {
    const { accepted, generated } = report.declaredAcceptances;
    line(ACCEPTED_HEADER);
    if (generated) {
      line(
        `  generated by ${generated.by} from ${generated.source} at ${generated.commit}`,
      );
    }
    for (const a of accepted) {
      const where = a.file !== undefined
        ? `${a.file}${a.line !== undefined ? `:${a.line}` : ""}`
        : "(extension)";
      line(`  ${a.ruleId} — ${where}: ${a.reason}`);
    }
  }
  if (report.forNextTime) {
    line(FOR_NEXT_TIME_HEADER);
    for (const entry of report.forNextTime) {
      const where = `${entry.file}${
        entry.line !== undefined ? `:${entry.line}` : ""
      }`;
      line(`  ${entry.ruleId} — ${where}: ${entry.message}`);
      if (entry.remediation) {
        line(`    fix: ${entry.remediation}`);
      }
      if (entry.acceptance) {
        line(`    or accept it, ${entry.placement}:`);
        for (const text of entry.acceptance.split("\n")) {
          line(`      ${text}`);
        }
      }
    }
  }
}

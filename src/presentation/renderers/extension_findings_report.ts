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
import { resolve } from "@std/path";
import { stringify } from "@std/yaml";
import { escapeLogTemplate } from "../../infrastructure/logging/logger.ts";
import {
  type Acceptance,
  acceptanceFor,
  type CommentSites,
} from "../../domain/extensions/extension_acceptances.ts";
import { isAcceptableRule } from "../../domain/extensions/extension_rule_catalog.ts";
import type { ReviewFinding } from "../../domain/extensions/extension_review_rules.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import type { DeclaredAcceptances } from "../../libswamp/extensions/push.ts";

/**
 * The findings report that closes a push summary, a dry run and a quality
 * run: what the author already accepted, and the warnings this run did not
 * resolve, each with how to fix it properly and, when the finding is not
 * right for this extension, the acceptance that declares it, described as
 * an edit an agent can apply. Built from the gated warnings themselves, not
 * from the flag waiver record, so a `--json` run, a dry run and an
 * interactive "y" all get it.
 */

/** One warning neither fixed nor accepted. */
export interface UnresolvedWarning {
  ruleId: string;
  /** The finding's absolute path; a label such as `(3 files)` passes through. */
  file: string;
  line?: number;
  message: string;
  /** How to fix the finding properly, from the rule catalog. */
  remediation?: string;
  /** The edit that accepts the finding; absent when the rule has no acceptance form. */
  acceptance?: Acceptance;
}

/** The two blocks, each present only when it has entries. */
export interface FindingsReport {
  declaredAcceptances?: DeclaredAcceptances;
  unresolvedWarnings?: UnresolvedWarning[];
}

/** The findings a run gates on, after acceptances. */
export interface GatedFindings {
  safetyWarnings: SafetyIssue[];
  reviewWarnings: ReviewFinding[];
  acceptances: DeclaredAcceptances;
  /** The warned lines a comment acceptance can go above, from the quality pass. */
  commentSites: Readonly<Record<string, CommentSites>>;
}

/** A finding with its acceptance attached, for the JSON warnings documents. */
export type WithAcceptance<T> = T & { acceptance?: Acceptance };

/**
 * Attaches the acceptance to each finding that has one. A collapsed
 * finding standing for several files has none here; the report's
 * unresolved warnings carry one per file.
 */
export function withAcceptance<T extends SafetyIssue | ReviewFinding>(
  findings: T[],
  manifestDir: string,
  sites: Readonly<Record<string, CommentSites>>,
): WithAcceptance<T>[] {
  return findings.map((finding) => {
    const acceptance = acceptanceFor(finding, manifestDir, sites);
    return acceptance ? { ...finding, acceptance } : finding;
  });
}

function unresolvedWarning(
  finding: SafetyIssue | ReviewFinding,
  manifestDir: string,
  sites: Readonly<Record<string, CommentSites>>,
): UnresolvedWarning {
  const acceptance = acceptanceFor(finding, manifestDir, sites);
  return {
    ruleId: finding.ruleId,
    file: finding.file,
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    message: finding.message.split("\n")[0],
    ...(finding.remediation !== undefined
      ? { remediation: finding.remediation }
      : {}),
    ...(acceptance ? { acceptance } : {}),
  };
}

/**
 * Builds the report. A collapsed testing-completeness finding expands to one
 * entry per remaining file, so each has its own header comment.
 */
export function buildFindingsReport(
  findings: GatedFindings,
  manifestDir: string,
): FindingsReport {
  const unresolvedWarnings: UnresolvedWarning[] = [];
  for (const w of findings.safetyWarnings) {
    unresolvedWarnings.push(
      unresolvedWarning(w, manifestDir, findings.commentSites),
    );
  }
  for (const w of findings.reviewWarnings) {
    if (w.files && w.files.length > 0) {
      // One entry per file the collapsed finding stands for, each with the
      // per-file wording so the advice reads per file.
      for (const file of w.files) {
        unresolvedWarnings.push(unresolvedWarning(
          {
            ...w,
            file,
            message: "No sibling `_test.ts` found — cover both success and " +
              "failure paths with unit tests before publishing.",
          },
          manifestDir,
          findings.commentSites,
        ));
      }
    } else {
      unresolvedWarnings.push(
        unresolvedWarning(w, manifestDir, findings.commentSites),
      );
    }
  }
  const hasAcceptances = findings.acceptances.accepted.length > 0 ||
    findings.acceptances.generated !== undefined;
  return {
    ...(hasAcceptances ? { declaredAcceptances: findings.acceptances } : {}),
    ...(unresolvedWarnings.length > 0 ? { unresolvedWarnings } : {}),
  };
}

/** The log-mode header strings, anchored by tests and UAT. */
export const ACCEPTED_HEADER = "Accepted warnings:";
export const UNRESOLVED_HEADER = "Unresolved warnings:";
/** Printed under an acceptable rule's warning that has no acceptance on its line. */
export const NO_ACCEPTANCE_HERE =
  "cannot be accepted here: the line is inside a string, comment or code block, or the file is outside the manifest's directory";

/** How the log form prints paths. */
export interface FindingsReportPaths {
  /** The manifest's directory, which declared acceptances' files are relative to. */
  manifestDir: string;
  /** An absolute path as the author can open it from where they ran the command. */
  display: (path: string) => string;
}

/** The acceptance as one line of advice: where it goes, then what to write. */
function acceptanceAdvice(acceptance: Acceptance): string {
  if (acceptance.form === "sidecar") {
    // The YAML stringifier quotes a file name that needs it, so the entry
    // stays valid YAML whatever the path holds.
    const entry = stringify(acceptance.entry, { flowLevel: 0 }).trim()
      .replace(/^\{/, "{ ").replace(/\}$/, " }");
    return `or accept in quality.yaml: ${entry}`;
  }
  // The text carries the indentation of the line it goes above; the advice
  // shows the comment alone.
  const comment = acceptance.text.trimStart();
  switch (acceptance.position) {
    case "line-above":
      return `or accept on the line above: ${comment}`;
    case "file-header":
      return `or accept at the top of the file: ${comment}`;
  }
}

/**
 * Prints the two blocks in log mode, each only when it has entries. Every
 * line is escaped before it reaches LogTape: a plain string is a message
 * template there, and messages, remediation and reasons carry braces
 * (`.meta({ sensitive: true })`, `z.object({})`).
 */
export function renderFindingsReport(
  logger: Logger,
  report: FindingsReport,
  paths: FindingsReportPaths,
): void {
  const line = (text: string) => logger.info(escapeLogTemplate(text));
  const where = (file: string, lineNumber?: number) =>
    `${file.startsWith("(") ? file : paths.display(file)}${
      lineNumber !== undefined ? `:${lineNumber}` : ""
    }`;
  if (report.declaredAcceptances) {
    const { accepted, generated } = report.declaredAcceptances;
    line(ACCEPTED_HEADER);
    if (generated) {
      line(
        `  generated by ${generated.by} from ${generated.source} at ${generated.commit}`,
      );
    }
    for (const a of accepted) {
      const at = a.file !== undefined
        ? where(resolve(paths.manifestDir, a.file), a.line)
        : "(extension)";
      line(
        `  ${a.ruleId} — ${at}${a.reason !== undefined ? `: ${a.reason}` : ""}`,
      );
    }
  }
  if (report.unresolvedWarnings) {
    line(UNRESOLVED_HEADER);
    for (const entry of report.unresolvedWarnings) {
      line(
        `  ${entry.ruleId} — ${
          where(entry.file, entry.line)
        }: ${entry.message}`,
      );
      if (entry.remediation) {
        line(`    fix: ${entry.remediation}`);
      }
      if (entry.acceptance) {
        line(`    ${acceptanceAdvice(entry.acceptance)}`);
      } else if (isAcceptableRule(entry.ruleId)) {
        // The rule takes an acceptance elsewhere; say why not here.
        line(`    ${NO_ACCEPTANCE_HERE}`);
      }
    }
  }
}

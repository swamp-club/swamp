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

import { extname } from "@std/path";
import {
  findRule,
  isAcceptableRule,
  isKnownRule,
  remediationFor,
  type RuleScope,
} from "./extension_rule_catalog.ts";
import type { ReviewFinding } from "./extension_review_rules.ts";

/**
 * Declared acceptances: an author's reasoned judgement that one warning-level
 * finding is acceptable, written where the finding is.
 *
 * A site-scoped finding (one line in one file) is accepted by a comment on
 * that line, or on the line directly above:
 *
 *     secretName: z.string(), // swamp-quality-ignore credentials-sensitive-field: reference to a Secret, not a secret
 *
 * A file-scoped finding (testing-completeness) is accepted by the same
 * comment anywhere in the file. Markdown files take an HTML comment on the
 * line above (`<!-- swamp-quality-ignore ipv4-address-literals: reason -->`).
 * Extension-scoped findings, and site findings in files with no comment
 * form (`.txt`), are accepted by an entry in the `quality.yaml` sidecar
 * beside the manifest (see `extension_quality_sidecar.ts`).
 *
 * An acceptance names one finding by (file, rule, line). It never widens: a
 * rule-wide or file-wide acceptance of a site-scoped rule is not expressible,
 * an error-level rule has no acceptance form, and a directive that matches
 * nothing is itself a warning (`stale-acceptance`). A directive that is
 * malformed, has no reason, or names a rule that cannot be accepted is a
 * blocking finding (`invalid-acceptance`).
 *
 * The parser reads raw lines. The detectors strip comments before matching,
 * so a directive never triggers the rule it accepts.
 */

/** The directive keyword, in the spirit of `deno-lint-ignore`. */
export const ACCEPTANCE_DIRECTIVE = "swamp-quality-ignore";

/** The longest reason a directive or sidecar entry may carry. */
export const MAX_ACCEPTANCE_REASON_LENGTH = 200;

/** The most directives one file may carry. */
export const MAX_DIRECTIVES_PER_FILE = 50;

/** Rule id grammar: lowercase words joined by hyphens. */
const RULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** What an acceptance names. */
export type AcceptanceTarget =
  /** One line of one file: a site-scoped finding. */
  | { kind: "line"; file: string; line: number }
  /** Every finding of the rule in one file: a file-scoped rule, or a sidecar entry for a `.txt` file. */
  | { kind: "file"; file: string }
  /** Every finding of the rule in the extension: an extension-scoped rule. */
  | { kind: "extension" };

/** Where an acceptance was declared. */
export type AcceptanceSource = "inline" | "sidecar" | "generated";

/** A declared acceptance, parsed from a comment or a sidecar entry. */
export interface AcceptanceDirective {
  ruleId: string;
  reason: string;
  target: AcceptanceTarget;
  source: AcceptanceSource;
  /**
   * For an inline directive, the file and 1-based line the comment sits on;
   * for a sidecar entry, the sidecar path and the entry's index.
   */
  declaredAt: { file: string; line: number };
}

/** A directive the parser could not accept, with why. */
export interface InvalidAcceptance {
  /** Where the directive sits. */
  file: string;
  line: number;
  /** The directive text as written, for the error message. */
  text: string;
  /** Why it is invalid. */
  problem: string;
}

/** Result of parsing one file's directives. */
export interface ParsedDirectives {
  directives: AcceptanceDirective[];
  invalid: InvalidAcceptance[];
}

/** The comment form a file kind takes, or none. */
export type CommentForm = "line" | "html" | "none";

/** The comment form for a file, by extension. */
export function commentFormFor(file: string): CommentForm {
  switch (extname(file).toLowerCase()) {
    case ".ts":
    case ".js":
    case ".tsx":
    case ".jsx":
      return "line";
    case ".md":
      return "html";
    default:
      return "none";
  }
}

/**
 * Validates a rule id and reason against the catalog and the caps, for an
 * acceptance declared in a comment, in a sidecar entry with no file (an
 * extension-scoped rule), or in a sidecar entry naming a file (a site or
 * file-scoped rule in a file with no comment form).
 */
export function validateAcceptance(
  ruleId: string,
  reason: string,
  where: "comment" | "sidecar" | "sidecar-file",
): string | undefined {
  if (!isKnownRule(ruleId)) {
    return `"${ruleId}" is not a rule id`;
  }
  const entry = findRule(ruleId)!;
  if (entry.severity === "error") {
    return `"${ruleId}" is an error-level rule and cannot be accepted`;
  }
  if (!isAcceptableRule(ruleId)) {
    return `"${ruleId}" is not a rule that can be accepted`;
  }
  if (reason.length === 0) {
    return "a reason is required after the colon";
  }
  if (reason.length > MAX_ACCEPTANCE_REASON_LENGTH) {
    return `the reason is longer than ${MAX_ACCEPTANCE_REASON_LENGTH} characters`;
  }
  if (where === "comment" && entry.scope === "extension") {
    return `"${ruleId}" is extension-scoped; declare it in quality.yaml beside the manifest`;
  }
  if (where === "sidecar" && entry.scope !== "extension") {
    return entry.scope === "site"
      ? `"${ruleId}" is site-scoped; declare it on the line in the source file, or name a .txt file`
      : `"${ruleId}" is file-scoped; declare it in the file, or use the generated declaration for a generated package`;
  }
  if (where === "sidecar-file" && entry.scope === "extension") {
    return `"${ruleId}" is extension-scoped and takes no file`;
  }
  return undefined;
}

/**
 * Parses the acceptance directives in one file. `file` is the path the
 * findings carry (absolute), so targets compare equal to findings.
 */
export function parseAcceptanceDirectives(
  content: string,
  file: string,
): ParsedDirectives {
  const form = commentFormFor(file);
  const directives: AcceptanceDirective[] = [];
  const invalid: InvalidAcceptance[] = [];
  if (form === "none") return { directives, invalid };

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = line.indexOf(ACCEPTANCE_DIRECTIVE);
    if (at === -1) continue;
    const lineNumber = i + 1;
    const opener = form === "line" ? "//" : "<!--";
    const openerAt = line.lastIndexOf(opener, at);
    if (openerAt === -1) {
      // The keyword outside a comment is not a directive (a string, prose).
      continue;
    }
    const betweenOpenerAndKeyword = line.slice(openerAt + opener.length, at);
    if (betweenOpenerAndKeyword.trim().length > 0) continue;

    const text = line.slice(openerAt).trim();
    if (directives.length + invalid.length >= MAX_DIRECTIVES_PER_FILE) {
      invalid.push({
        file,
        line: lineNumber,
        text,
        problem:
          `more than ${MAX_DIRECTIVES_PER_FILE} acceptance directives in one file`,
      });
      continue;
    }

    let body = line.slice(at + ACCEPTANCE_DIRECTIVE.length);
    if (form === "html") {
      const close = body.indexOf("-->");
      if (close === -1) {
        invalid.push({
          file,
          line: lineNumber,
          text,
          problem: "the HTML comment is not closed on the same line",
        });
        continue;
      }
      body = body.slice(0, close);
    }
    const match = /^\s+([^\s:]+)\s*:\s*(.*?)\s*$/.exec(body);
    if (!match) {
      invalid.push({
        file,
        line: lineNumber,
        text,
        problem: `expected "${ACCEPTANCE_DIRECTIVE} <rule-id>: <reason>"`,
      });
      continue;
    }
    const ruleId = match[1];
    const reason = match[2];
    if (!RULE_ID_PATTERN.test(ruleId)) {
      invalid.push({
        file,
        line: lineNumber,
        text,
        problem: `"${ruleId}" is not a rule id`,
      });
      continue;
    }
    const problem = validateAcceptance(ruleId, reason, "comment");
    if (problem !== undefined) {
      invalid.push({ file, line: lineNumber, text, problem });
      continue;
    }

    const scope: RuleScope = findRule(ruleId)!.scope;
    let target: AcceptanceTarget;
    if (scope === "file") {
      target = { kind: "file", file };
    } else {
      const standalone = line.slice(0, openerAt).trim().length === 0;
      target = {
        kind: "line",
        file,
        line: standalone ? lineNumber + 1 : lineNumber,
      };
    }
    directives.push({
      ruleId,
      reason,
      target,
      source: "inline",
      declaredAt: { file, line: lineNumber },
    });
  }
  return { directives, invalid };
}

/** The identity a finding carries; both finding types satisfy it. */
export interface AcceptableFinding {
  ruleId: string;
  file: string;
  line?: number;
}

/** A finding together with the acceptance that covers it. */
export interface AcceptedFinding<T extends AcceptableFinding> {
  finding: T;
  reason: string;
  source: AcceptanceSource;
  declaredAt: { file: string; line: number };
}

/** The partitions {@link applyAcceptances} produces. */
export interface AppliedAcceptances<T extends AcceptableFinding> {
  /** Findings no acceptance covers; they stay in the gate. */
  remaining: T[];
  /** Findings an acceptance covers, with the reason. */
  accepted: AcceptedFinding<T>[];
  /** Inline and sidecar acceptances that matched no finding. */
  stale: AcceptanceDirective[];
}

/** True when the directive names the finding. */
function covers(
  directive: AcceptanceDirective,
  finding: AcceptableFinding,
): boolean {
  if (directive.ruleId !== finding.ruleId) return false;
  const target = directive.target;
  switch (target.kind) {
    case "line":
      return target.file === finding.file && target.line === finding.line;
    case "file":
      return target.file === finding.file;
    case "extension":
      return true;
  }
}

/**
 * Applies declared acceptances to findings. Pure: a finding moves to
 * `accepted` only when a directive names it, every other finding is kept
 * unchanged in `remaining`, and the two together are exactly the input. A
 * directive that names nothing is returned as `stale`, except a `generated`
 * declaration, which is a statement about the package rather than about one
 * finding.
 */
export function applyAcceptances<T extends AcceptableFinding>(
  findings: T[],
  directives: AcceptanceDirective[],
): AppliedAcceptances<T> {
  const remaining: T[] = [];
  const accepted: AcceptedFinding<T>[] = [];
  const used = new Set<AcceptanceDirective>();

  for (const finding of findings) {
    const directive = directives.find((d) => covers(d, finding));
    if (directive === undefined) {
      remaining.push(finding);
      continue;
    }
    used.add(directive);
    accepted.push({
      finding,
      reason: directive.reason,
      source: directive.source,
      declaredAt: directive.declaredAt,
    });
  }

  const stale = directives.filter((d) =>
    !used.has(d) && d.source !== "generated"
  );
  return { remaining, accepted, stale };
}

const ACCEPTANCE_DIMENSION = "Declared acceptances";

/** The blocking finding for a directive that cannot be accepted. */
export function invalidAcceptanceFinding(
  issue: InvalidAcceptance,
): ReviewFinding {
  return {
    ruleId: "invalid-acceptance",
    dimension: ACCEPTANCE_DIMENSION,
    severity: "high",
    file: issue.file,
    line: issue.line,
    message: `Acceptance "${issue.text}" is invalid: ${issue.problem}.`,
  };
}

/** The warning for a directive that names no finding. */
export function staleAcceptanceFinding(
  directive: AcceptanceDirective,
): ReviewFinding {
  const where = directive.target.kind === "line"
    ? `line ${directive.target.line}`
    : directive.target.kind === "file"
    ? "this file"
    : "this extension";
  return {
    ruleId: "stale-acceptance",
    dimension: ACCEPTANCE_DIMENSION,
    severity: "medium",
    file: directive.declaredAt.file,
    line: directive.declaredAt.line,
    message:
      `Acceptance of ${directive.ruleId} matches nothing: the rule does not fire on ${where}. Remove it.`,
    remediation: remediationFor("stale-acceptance"),
  };
}

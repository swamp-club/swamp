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

import { parse } from "@babel/parser";
import { BABEL_PLUGINS } from "./dynamic_code_detector.ts";
import { extname, isAbsolute, join, relative, SEPARATOR } from "@std/path";
import {
  findRule,
  isAcceptableRule,
  isKnownRule,
  remediationFor,
  type RuleScope,
} from "./extension_rule_catalog.ts";
import type { ReviewFinding } from "./extension_review_rules.ts";

/**
 * Declared acceptances: an author's judgement that one warning-level finding
 * is acceptable, written where the finding is and reviewed in the diff.
 *
 * A site-scoped finding (one line in one file) is accepted by a comment on
 * that line, or on the line directly above, with an optional reason after a
 * colon:
 *
 *     secretName: z.string(), // swamp-quality-ignore credentials-sensitive-field
 *     secretRef: z.string(), // swamp-quality-ignore credentials-sensitive-field: reference to a Secret, not a secret
 *
 * A file-scoped finding (testing-completeness) is accepted by the same
 * comment anywhere in the file. Markdown files take an HTML comment on the
 * line above (`<!-- swamp-quality-ignore ipv4-address-literals -->`).
 * Extension-scoped findings, and site findings in files with no comment
 * form (`.txt`), are accepted by an entry in the `quality.yaml` sidecar
 * beside the manifest (see `extension_quality_sidecar.ts`).
 *
 * An acceptance names one finding by (file, rule, line). It never widens: a
 * rule-wide or file-wide acceptance of a site-scoped rule is not expressible,
 * an error-level rule has no acceptance form, and a directive that matches
 * nothing is itself a warning (`stale-acceptance`). A directive that is
 * malformed or names a rule that cannot be accepted is a blocking finding
 * (`invalid-acceptance`).
 *
 * The parser reads raw lines. The review rules strip comments before
 * matching, and the safety checks scan every line as written; a directive's
 * reason, when given, may not contain a quote, `Deno.Command(` or a base64
 * run, so a
 * directive cannot trigger the rule it accepts and nothing can hide behind
 * one. Only the long-line count discounts the directive's own text.
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
  /** Why the author accepts the finding; absent when they gave none. */
  reason?: string;
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
 * Validates a rule id and optional reason against the catalog and the caps, for an
 * acceptance declared in a comment, in a sidecar entry with no file (an
 * extension-scoped rule), or in a sidecar entry naming a file (a site or
 * file-scoped rule in a file with no comment form).
 */
export function validateAcceptance(
  ruleId: string,
  reason: string | undefined,
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
    // The problem is quoted inside a sentence the caller ends with a period.
    return entry.remediation
      ? `"${ruleId}" is not a rule that can be accepted. ${
        entry.remediation.replace(/\.$/, "")
      }`
      : `"${ruleId}" is not a rule that can be accepted`;
  }
  if (
    reason !== undefined && reason.length > MAX_ACCEPTANCE_REASON_LENGTH
  ) {
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
  if (where === "sidecar-file" && entry.scope !== "site") {
    return entry.scope === "extension"
      ? `"${ruleId}" is extension-scoped and takes no file`
      : `"${ruleId}" is file-scoped; declare it in the file itself, or use the generated declaration for a generated package`;
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
  // Text that documents a directive is not one: a Markdown fenced code block,
  // or a `/* ... */` block (a JSDoc example) in source.
  let fenced = false;
  let blockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (form === "html") {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
    } else {
      if (blockComment) {
        if (line.includes("*/")) blockComment = false;
        continue;
      }
      const open = line.indexOf("/*");
      if (
        open !== -1 && !isInsideQuotes(line, open) &&
        !lineCommentBefore(line, open) &&
        !line.includes("*/", open + 1)
      ) {
        // A block comment spanning lines (a JSDoc example) is documentation.
        // One that closes on its own line is parsed as usual, and a
        // directive inside it is refused below.
        blockComment = true;
        continue;
      }
    }
    const found = findDirectiveStart(line, form);
    if (found === undefined) continue;
    const { at, openerAt } = found;
    const lineNumber = i + 1;

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
    if (form === "line" && body.includes("*/")) {
      // A `//` inside a `/* ... */` block: code after the `*/` would be
      // hidden from the safety scan, so the directive must end its line.
      invalid.push({
        file,
        line: lineNumber,
        text,
        problem:
          "a block comment closes after the directive; the directive must end its line",
      });
      continue;
    }
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
    // `<rule-id>`, `<rule-id>:` or `<rule-id>: <reason>`. Text after the
    // rule id without a colon is ambiguous, so it is malformed.
    const match = /^\s+([^\s:]+)\s*(?::\s*(.*?))?\s*$/.exec(body);
    if (!match) {
      invalid.push({
        file,
        line: lineNumber,
        text,
        problem:
          `expected "${ACCEPTANCE_DIRECTIVE} <rule-id>" or "${ACCEPTANCE_DIRECTIVE} <rule-id>: <reason>"`,
      });
      continue;
    }
    const ruleId = match[1];
    const reason = match[2] ? match[2] : undefined;
    if (!RULE_ID_PATTERN.test(ruleId)) {
      invalid.push({
        file,
        line: lineNumber,
        text,
        problem: `"${ruleId}" is not a rule id`,
      });
      continue;
    }
    const problem = validateAcceptance(ruleId, reason, "comment") ??
      (form === "line" && reason !== undefined
        ? reasonProblemInSource(reason)
        : undefined);
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
        line: standalone ? nextTargetLine(lines, i, form) : lineNumber,
      };
    }
    directives.push({
      ruleId,
      ...(reason !== undefined ? { reason } : {}),
      target,
      source: "inline",
      declaredAt: { file, line: lineNumber },
    });
  }
  return { directives, invalid };
}

/** A run the safety analyzer reads as base64. */
const BASE64_RUN = /[A-Za-z0-9+/=]{100,}/;

/**
 * Why a reason may not appear in a source comment. The safety analyzer
 * scans source lines as written, so the reason must not carry anything the
 * line checks would match, and must not carry a quote, which could make a
 * string's text read as a comment.
 */
function reasonProblemInSource(reason: string): string | undefined {
  if (/["'`]/.test(reason)) {
    return "the reason may not contain a quote character";
  }
  if (reason.includes("Deno.Command(")) {
    return "the reason may not contain Deno.Command(";
  }
  if (BASE64_RUN.test(reason)) {
    return "the reason may not contain a run of 100 or more base64 characters";
  }
  return undefined;
}

/**
 * The 1-based number of the line a standalone directive at index `i`
 * targets: the first following line that is not another standalone
 * directive (stacked directives all target the same line), allowing one
 * blank line in between, which a formatter puts after an HTML comment
 * block. Falls back to the next line when nothing qualifies, which then
 * reads as stale.
 */
function nextTargetLine(
  lines: string[],
  i: number,
  form: Exclude<CommentForm, "none">,
): number {
  let blanksSkipped = 0;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim().length === 0) {
      if (blanksSkipped >= 1) break;
      blanksSkipped++;
      continue;
    }
    if (isStandaloneDirectiveLine(lines[j], form)) {
      blanksSkipped = 0;
      continue;
    }
    return j + 1;
  }
  return i + 2;
}

/**
 * Finds the directive on a line: the first keyword that directly follows a
 * comment opener which is not inside a string literal. The keyword inside a
 * string, or outside a comment, is not a directive.
 */
function findDirectiveStart(
  line: string,
  form: Exclude<CommentForm, "none">,
): { at: number; openerAt: number } | undefined {
  const opener = form === "line" ? "//" : "<!--";
  let from = 0;
  while (from < line.length) {
    const at = line.indexOf(ACCEPTANCE_DIRECTIVE, from);
    if (at === -1) return undefined;
    const openerAt = line.lastIndexOf(opener, at);
    // Quote tracking applies to source lines only: an apostrophe in
    // Markdown prose must not hide a trailing HTML comment.
    const quoted = form === "line" && isInsideQuotes(line, openerAt);
    if (
      openerAt !== -1 && !quoted &&
      line.slice(openerAt + opener.length, at).trim().length === 0
    ) {
      return { at, openerAt };
    }
    from = at + ACCEPTANCE_DIRECTIVE.length;
  }
  return undefined;
}

/**
 * The span of the acceptance directive on a line, as `[start, end)` column
 * offsets, or undefined when the line carries none. This is the one
 * definition of where a directive sits: the parser uses it to read the
 * directive, and the safety analyzer uses it to drop exactly that text
 * before scanning, so a directive never triggers the rule it accepts and
 * the same marker inside a string literal is still scanned.
 */
export function directiveSpan(
  line: string,
  file: string,
): { start: number; end: number } | undefined {
  const form = commentFormFor(file);
  if (form === "none") return undefined;
  const found = findDirectiveStart(line, form);
  if (found === undefined) return undefined;
  if (form === "line") return { start: found.openerAt, end: line.length };
  const close = line.indexOf("-->", found.at);
  return {
    start: found.openerAt,
    end: close === -1 ? line.length : close + "-->".length,
  };
}

/**
 * The line with its acceptance directive removed. Used for the long-line
 * count and for Markdown content rules, where the HTML span is bounded by
 * `-->`; the other safety checks scan the line as written. A span whose text
 * holds a quote character is left in place, since the opener could then be
 * inside a string.
 */
export function withoutDirective(line: string, file: string): string {
  const span = directiveSpan(line, file);
  if (span === undefined) return line;
  if (/["'`]/.test(line.slice(span.start, span.end))) return line;
  return line.slice(0, span.start) + line.slice(span.end);
}

/** True when the line is nothing but a standalone acceptance directive. */
function isStandaloneDirectiveLine(
  line: string,
  form: Exclude<CommentForm, "none">,
): boolean {
  const found = findDirectiveStart(line, form);
  return found !== undefined &&
    line.slice(0, found.openerAt).trim().length === 0;
}

/** True when a `//` line comment (not inside quotes) starts before `index`. */
function lineCommentBefore(line: string, index: number): boolean {
  let from = 0;
  while (from < index) {
    const at = line.indexOf("//", from);
    if (at === -1 || at >= index) return false;
    if (!isInsideQuotes(line, at)) return true;
    from = at + 2;
  }
  return false;
}

/** True when `index` sits inside a quoted string literal on the line. */
function isInsideQuotes(line: string, index: number): boolean {
  let quote: string | undefined;
  for (let k = 0; k < index; k++) {
    const ch = line[k];
    if (quote !== undefined) {
      if (ch === "\\") k++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    }
  }
  return quote !== undefined;
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
  /** The acceptance's reason; absent when the author gave none. */
  reason?: string;
  source: AcceptanceSource;
  declaredAt: { file: string; line: number };
}

/** The partitions {@link applyAcceptances} produces. */
export interface AppliedAcceptances<T extends AcceptableFinding> {
  /** Findings no acceptance covers; they stay in the gate. */
  remaining: T[];
  /** Findings an acceptance covers, with the reason when one was given. */
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
      ...(directive.reason !== undefined ? { reason: directive.reason } : {}),
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

// ── Structured acceptances ────────────────────────────────────────────

/** Where a comment acceptance goes relative to its `line`. */
export const ACCEPTANCE_POSITIONS = [
  /** On a new line inserted directly above `line`. */
  "line-above",
  /** On a new line inserted at the top of the file (after a shebang); `line` is 1. */
  "file-header",
] as const;

/** Where a comment acceptance goes relative to its `line`. */
export type AcceptancePosition = typeof ACCEPTANCE_POSITIONS[number];

/** One entry for the `accept` list of `quality.yaml`. */
export interface SidecarAcceptanceEntry {
  rule: string;
  /** Relative to the manifest's directory with forward slashes; absent for an extension-scoped rule. */
  file?: string;
}

/**
 * The edit that declares one finding acceptable, described so an agent can
 * apply it without parsing prose: a comment to insert at a position in a
 * file, or one entry to add to the `accept` list of the quality sidecar.
 * Neither carries a reason; the author adds one only when it helps a
 * reviewer.
 */
export type Acceptance =
  | {
    form: "comment";
    /** The absolute path of the file to edit. */
    file: string;
    /** The 1-based line `position` is relative to. */
    line: number;
    position: AcceptancePosition;
    /**
     * The whole line to insert, indented like the line it goes above, e.g.
     * `    // swamp-quality-ignore deno-command`. A `file-header` comment
     * goes after a `#!` shebang when the file starts with one.
     */
    text: string;
  }
  | {
    form: "sidecar";
    /** The absolute path of `quality.yaml` beside the manifest, which may not exist yet. */
    file: string;
    /** The entry to add to its `accept` list. */
    entry: SidecarAcceptanceEntry;
  };

/** The sidecar's file name; `QUALITY_SIDECAR_FILENAME` in `extension_quality_sidecar.ts`, which imports this module. */
const SIDECAR_FILENAME = "quality.yaml";

function escapesDir(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + SEPARATOR) || isAbsolute(rel);
}

/**
 * A finding's file relative to the manifest's directory, with forward
 * slashes, for the summaries. A file elsewhere in the repository (a vault
 * beside a `extensions/models/manifest.yaml`) is a `../` path when
 * `repoDir` is given; a file outside the repository (the adversarial-review
 * report in the review dir) keeps its absolute path.
 */
export function fileRelativeToManifest(
  manifestDir: string,
  file: string,
  repoDir?: string,
): string {
  if (file.startsWith("(")) return file;
  const rel = relative(manifestDir, file);
  if (!escapesDir(rel)) return rel.replaceAll("\\", "/");
  if (repoDir !== undefined && !escapesDir(relative(repoDir, file))) {
    return rel.replaceAll("\\", "/");
  }
  return file;
}

/**
 * The warned lines of one file that a comment acceptance can go above, each
 * with its indentation, which the inserted comment copies so the file stays
 * formatted. A line is absent when it begins inside a multi-line string,
 * template literal or block comment in source, or inside a fenced block in
 * Markdown, where a comment would be ignored as documentation or, in a
 * string, change what the program does; every line is absent from a source
 * file that does not parse, since none can be vouched for.
 */
export type CommentSites = Record<number, string>;

/** The {@link CommentSites} of `lines` in one file with a comment form. */
export function commentSites(
  content: string,
  file: string,
  lines: readonly number[],
): CommentSites {
  const text = content.split("\n");
  const barriers = new Set<number>();
  const form = commentFormFor(file);
  if (form === "html") {
    let fenced = false;
    let inComment = false;
    text.forEach((line, i) => {
      // The lines after an opening fence through its closing fence, and
      // the lines after a multi-line HTML comment opens through the one
      // that closes it: a comment inserted there would end it early.
      if (fenced || inComment) barriers.add(i + 1);
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      const open = line.lastIndexOf("<!--");
      const close = line.lastIndexOf("-->");
      if (open !== -1 && open > close) inComment = true;
      else if (inComment && close !== -1) inComment = false;
    });
  } else {
    let spans: {
      loc?: { start: { line: number }; end: { line: number } } | null;
    }[];
    try {
      const parsed = parse(content, {
        sourceType: "module",
        plugins: extname(file).toLowerCase().endsWith("x")
          ? [...BABEL_PLUGINS, "jsx"]
          : BABEL_PLUGINS,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowUndeclaredExports: true,
        allowNewTargetOutsideFunction: true,
        allowSuperOutsideMethod: true,
        errorRecovery: false,
        tokens: true,
      });
      spans = [...(parsed.tokens ?? []), ...(parsed.comments ?? [])];
    } catch {
      return {};
    }
    // A token or comment spanning lines covers every line after its first.
    for (const span of spans) {
      const loc = span.loc;
      if (!loc) continue;
      for (let l = loc.start.line + 1; l <= loc.end.line; l++) {
        barriers.add(l);
      }
    }
  }
  const sites: CommentSites = {};
  for (const line of lines) {
    if (line < 1 || line > text.length || barriers.has(line)) continue;
    const indent = /^[ \t]*/.exec(text[line - 1])![0];
    if (!parserReadsDirectiveAbove(text, file, line, indent)) continue;
    sites[line] = indent;
  }
  return sites;
}

/**
 * True when a directive inserted above `line` is one the parser reads and
 * aims at that line. The parser's own line heuristics (a `/*` it reads as
 * an open block comment, a fence) can disagree with the tokenizer, and an
 * offered acceptance must take effect.
 */
function parserReadsDirectiveAbove(
  text: string[],
  file: string,
  line: number,
  indent: string,
): boolean {
  // Any acceptable site rule serves; the parser's placement does not depend
  // on which one it is.
  const probe = `${ACCEPTANCE_DIRECTIVE} deno-command`;
  const directive = commentFormFor(file) === "html"
    ? `${indent}<!-- ${probe} -->`
    : `${indent}// ${probe}`;
  const edited = [
    ...text.slice(0, line - 1),
    directive,
    ...text.slice(line - 1),
  ];
  const parsed = parseAcceptanceDirectives(edited.join("\n"), file);
  return parsed.directives.some((d) =>
    d.declaredAt.line === line && d.target.kind === "line" &&
    d.target.line === line + 1
  );
}

/**
 * The acceptance that declares `finding` acceptable, or undefined when it
 * has none: a rule with no acceptance form, a collapsed finding standing for
 * several files (each file takes its own), a site finding with no line, a
 * file with no comment form outside the manifest's directory, which the
 * sidecar cannot name, or a line a comment cannot go above (absent from
 * the file's {@link CommentSites} in `sites`). `finding.file` is the
 * absolute path findings carry.
 */
export function acceptanceFor(
  finding: AcceptableFinding,
  manifestDir: string,
  sites: Readonly<Record<string, CommentSites>>,
): Acceptance | undefined {
  if (!isAcceptableRule(finding.ruleId)) return undefined;
  const scope = findRule(finding.ruleId)!.scope;
  const sidecarFile = join(manifestDir, SIDECAR_FILENAME);
  // An extension-scoped finding names no file (its file is a label such as
  // `(multiple files)`); the sidecar entry covers the extension.
  if (scope === "extension") {
    return {
      form: "sidecar",
      file: sidecarFile,
      entry: { rule: finding.ruleId },
    };
  }
  if (finding.file.startsWith("(")) return undefined;
  const form = commentFormFor(finding.file);
  const directive = `${ACCEPTANCE_DIRECTIVE} ${finding.ruleId}`;
  if (scope === "file") {
    // A file-scoped rule is accepted in the file itself, anywhere in it;
    // the top is where an author looks for it.
    return {
      form: "comment",
      file: finding.file,
      line: 1,
      position: "file-header",
      text: `// ${directive}`,
    };
  }
  if (form === "none") {
    const rel = relative(manifestDir, finding.file);
    if (escapesDir(rel)) return undefined;
    return {
      form: "sidecar",
      file: sidecarFile,
      entry: { rule: finding.ruleId, file: rel.replaceAll("\\", "/") },
    };
  }
  if (finding.line === undefined) return undefined;
  const indent = sites[finding.file]?.[finding.line];
  if (indent === undefined) return undefined;
  // On its own line above the finding, never at the end of it: several
  // findings on one line each take a directive, and stacked directives all
  // name the line below them.
  return {
    form: "comment",
    file: finding.file,
    line: finding.line,
    position: "line-above",
    text: indent +
      (form === "line" ? `// ${directive}` : `<!-- ${directive} -->`),
  };
}

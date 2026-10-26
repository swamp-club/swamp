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

import { parse, type ParserPlugin } from "@babel/parser";
import { BABEL_PLUGINS, LineIndex } from "./extension_source_ast.ts";
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
 * In source, the parser reads directives from the comments Babel finds, so
 * the keyword inside a string, template or regex literal is never a
 * directive; a source file that does not parse has every directive reported
 * invalid. Markdown is read line by line. The review rules strip comments
 * before matching, and the long-line and base64 safety checks scan every
 * line as written; `deno-command` reads the syntax tree, but scans lines as
 * written in a file that does not parse. A directive's reason, when given,
 * may not contain `Deno.Command(` or a base64 run, so a directive cannot
 * trigger the rule it accepts and nothing can hide behind one. Only the
 * long-line count discounts the directive's own text.
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
  const { sites, parsed } = directiveSitesOf(content, file, form, lines);
  for (const [lineNumber, site] of sites) {
    const line = lines[lineNumber - 1];
    const text = line.slice(site.openerAt).trim();
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
    if (!parsed) {
      // Without a parse there is no telling a comment from a string's text,
      // so no directive in the file is read.
      invalid.push({
        file,
        line: lineNumber,
        text,
        problem:
          "the file does not parse, so its acceptance comments cannot be read; fix the syntax error",
      });
      continue;
    }
    if (site.inBlock) {
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

    let body = form === "line"
      ? line.slice(site.at + ACCEPTANCE_DIRECTIVE.length, site.end)
      : line.slice(site.at + ACCEPTANCE_DIRECTIVE.length);
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
      target = {
        kind: "line",
        file,
        line: isStandaloneSite(lines, sites, lineNumber)
          ? nextTargetLine(lines, lineNumber - 1, sites)
          : lineNumber,
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
 * scans source lines as written for long lines and base64 runs, and for
 * `Deno.Command(` in a file that does not parse, so the reason must not
 * carry anything those line checks would match. A quote is harmless: the
 * directive is read from a comment the parser found, so its text can never
 * end a string.
 */
function reasonProblemInSource(reason: string): string | undefined {
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
  sites: ReadonlyMap<number, DirectiveSite>,
): number {
  let blanksSkipped = 0;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim().length === 0) {
      if (blanksSkipped >= 1) break;
      blanksSkipped++;
      continue;
    }
    if (isStandaloneSite(lines, sites, j + 1)) {
      blanksSkipped = 0;
      continue;
    }
    return j + 1;
  }
  return i + 2;
}

/**
 * A directive comment on one line, as 0-based column offsets on that line:
 * the `//` or `<!--` before the keyword, the keyword, and where the comment
 * ends. Every comment that carries the keyword after an opener is a site,
 * valid or not, so an invalid directive in a stack still counts as one.
 */
interface DirectiveSite {
  openerAt: number;
  at: number;
  end: number;
  /** A `//` directive inside a block comment that closes on the same line. */
  inBlock?: true;
}

/** The directive sites of one file, by 1-based line in line order. */
interface FileDirectiveSites {
  sites: Map<number, DirectiveSite>;
  /** False for a source file that does not parse; its sites are a text scan. */
  parsed: boolean;
}

/**
 * Where the directives sit in one file. Source is read from the comments
 * Babel finds, so the keyword inside a string, template or regex literal is
 * never a directive and a quote in a comment cannot hide one. Markdown is
 * read line by line outside fenced code blocks, where the keyword must
 * follow `<!--`.
 */
function directiveSitesOf(
  content: string,
  file: string,
  form: Exclude<CommentForm, "none">,
  lines: string[],
): FileDirectiveSites {
  if (form === "html") return { sites: markdownSites(lines), parsed: true };
  const parsed = parseSource(content, file, false);
  if (parsed === null) {
    const sites = new Map<number, DirectiveSite>();
    lines.forEach((line, i) => {
      const found = keywordAfterOpener(line, "//");
      if (found) sites.set(i + 1, { ...found, end: line.length });
    });
    return { sites, parsed: false };
  }
  return { sites: sourceSites(content, parsed.comments), parsed: true };
}

/** A token or comment's offsets, as Babel reports them. */
interface SourceSpan {
  type?: string;
  start?: number | null;
  end?: number | null;
}

/**
 * Parses source as a module with the plugins its extension needs, or
 * returns null when it does not parse. JavaScript is parsed without the
 * TypeScript plugin, which refuses some valid JavaScript.
 */
function parseSource(
  content: string,
  file: string,
  tokens: boolean,
): { tokens: SourceSpan[]; comments: SourceSpan[] } | null {
  const ext = extname(file).toLowerCase();
  const base = ext === ".js" || ext === ".jsx"
    ? BABEL_PLUGINS.filter((p) => p !== "typescript")
    : BABEL_PLUGINS;
  const plugins: ParserPlugin[] = ext.endsWith("x") ? [...base, "jsx"] : base;
  try {
    const parsed = parse(content, {
      sourceType: "module",
      plugins,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowUndeclaredExports: true,
      allowNewTargetOutsideFunction: true,
      allowSuperOutsideMethod: true,
      errorRecovery: false,
      tokens,
    });
    return { tokens: parsed.tokens ?? [], comments: parsed.comments ?? [] };
  } catch {
    return null;
  }
}

/**
 * The directive sites among a parsed file's comments: the first comment on
 * a line whose text holds the keyword directly after a `//`, its own or a
 * later one (`// note // swamp-quality-ignore <rule-id>`). A block comment
 * spanning lines (a JSDoc example) is documentation. Lines are counted by
 * `\n` alone, and a line comment ends where Babel ends it, so a `\r` or a
 * U+2028 after it is not part of the directive.
 */
function sourceSites(
  content: string,
  comments: SourceSpan[],
): Map<number, DirectiveSite> {
  const index = new LineIndex(content);
  const sites = new Map<number, DirectiveSite>();
  for (const comment of comments) {
    if (typeof comment.start !== "number" || typeof comment.end !== "number") {
      continue;
    }
    const start = index.position(comment.start);
    const end = index.position(comment.end);
    if (start.line !== end.line || sites.has(start.line)) continue;
    const found = keywordAfterOpener(
      content.slice(comment.start, comment.end),
      "//",
    );
    if (found === undefined) continue;
    sites.set(start.line, {
      openerAt: start.column - 1 + found.openerAt,
      at: start.column - 1 + found.at,
      end: end.column - 1,
      ...(comment.type === "CommentBlock" ? { inBlock: true as const } : {}),
    });
  }
  return sites;
}

/**
 * The directive sites of a Markdown file: lines outside fenced code blocks
 * where the keyword follows `<!--`. Text that documents a directive in a
 * fence is not one.
 */
function markdownSites(lines: string[]): Map<number, DirectiveSite> {
  const sites = new Map<number, DirectiveSite>();
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const found = keywordAfterOpener(line, "<!--");
    if (found === undefined) return;
    const close = line.indexOf("-->", found.at);
    sites.set(i + 1, {
      ...found,
      end: close === -1 ? line.length : close + "-->".length,
    });
  });
  return sites;
}

/**
 * The first keyword in `text` that directly follows `opener`, with only
 * whitespace between, as offsets into `text`.
 */
function keywordAfterOpener(
  text: string,
  opener: string,
): { at: number; openerAt: number } | undefined {
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(ACCEPTANCE_DIRECTIVE, from);
    if (at === -1) return undefined;
    const openerAt = text.lastIndexOf(opener, at);
    if (
      openerAt !== -1 &&
      text.slice(openerAt + opener.length, at).trim().length === 0
    ) {
      return { at, openerAt };
    }
    from = at + ACCEPTANCE_DIRECTIVE.length;
  }
  return undefined;
}

/** True when the 1-based line is nothing but a directive comment. */
function isStandaloneSite(
  lines: string[],
  sites: ReadonlyMap<number, DirectiveSite>,
  lineNumber: number,
): boolean {
  const site = sites.get(lineNumber);
  return site !== undefined &&
    lines[lineNumber - 1].slice(0, site.openerAt).trim().length === 0;
}

/** Where an acceptance directive sits on its line, as `[start, end)` column offsets. */
export interface DirectiveSpan {
  start: number;
  end: number;
}

/**
 * The span of each acceptance directive in a file, by 1-based line. This is
 * the one definition of where a directive sits: the parser reads the
 * directives at these places, and the safety analyzer drops exactly this
 * text before the long-line count and the Markdown content rules, so a
 * directive never triggers the rule it accepts and the keyword inside a
 * string literal is still scanned. A source file that does not parse has
 * none, since none of its directives are read. A Markdown span holding a
 * quote is left out, as it always was.
 */
export function directiveSpans(
  content: string,
  file: string,
): Map<number, DirectiveSpan> {
  const spans = new Map<number, DirectiveSpan>();
  const form = commentFormFor(file);
  if (form === "none") return spans;
  const lines = content.split("\n");
  const { sites, parsed } = directiveSitesOf(content, file, form, lines);
  if (!parsed) return spans;
  for (const [lineNumber, site] of sites) {
    if (site.inBlock) continue;
    if (
      form === "html" &&
      /["'`]/.test(lines[lineNumber - 1].slice(site.openerAt, site.end))
    ) {
      continue;
    }
    spans.set(lineNumber, { start: site.openerAt, end: site.end });
  }
  return spans;
}

/** The line with the directive `span` (from {@link directiveSpans}) removed. */
export function withoutDirective(
  line: string,
  span: DirectiveSpan | undefined,
): string {
  if (span === undefined) return line;
  return line.slice(0, span.start) + line.slice(span.end);
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
  /** The one line of `file` the entry accepts: a Markdown line inside a fenced code block. */
  line?: number;
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
  // A source file's directive sites, from the parse that finds its barriers.
  let directives: Map<number, DirectiveSite> | undefined;
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
    const parsed = parseSource(content, file, true);
    if (parsed === null) return {};
    // A token or comment spanning lines covers every line after its first.
    // Lines are counted from offsets, by `\n` alone like `text`, not from
    // Babel's `loc`, which also breaks at `\r`, U+2028 and U+2029.
    const index = new LineIndex(content);
    for (const span of [...parsed.tokens, ...parsed.comments]) {
      if (typeof span.start !== "number" || typeof span.end !== "number") {
        continue;
      }
      const last = index.position(span.end).line;
      for (let l = index.position(span.start).line + 1; l <= last; l++) {
        barriers.add(l);
      }
    }
    directives = sourceSites(content, parsed.comments);
  }
  const sites: CommentSites = {};
  for (const line of lines) {
    if (line < 1 || line > text.length || barriers.has(line)) continue;
    const indent = /^[ \t]*/.exec(text[line - 1])![0];
    const reads = directives === undefined
      ? parserReadsDirectiveAbove(text, file, line, indent)
      : sourceReadsDirectiveAbove(text, directives, line);
    if (!reads) continue;
    sites[line] = indent;
  }
  return sites;
}

/**
 * True when a `//` directive inserted above `line` of a parsed source file
 * is one the parser reads and aims at that line, decided from the file's
 * one parse. Above a line no token or comment spans, the inserted line is
 * a line comment of its own; it aims at `line` unless `line` is itself a
 * standalone directive, which a stack skips, and it is read unless the
 * directives before it already reach the cap.
 */
function sourceReadsDirectiveAbove(
  text: string[],
  directives: ReadonlyMap<number, DirectiveSite>,
  line: number,
): boolean {
  if (isStandaloneSite(text, directives, line)) return false;
  let before = 0;
  for (const at of directives.keys()) if (at < line) before++;
  return before < MAX_DIRECTIVES_PER_FILE;
}

/**
 * True when a directive inserted above `line` of a Markdown file is one the
 * parser reads and aims at that line. The parser's fence and comment
 * handling can disagree with the barriers, and an offered acceptance must
 * take effect.
 */
function parserReadsDirectiveAbove(
  text: string[],
  file: string,
  line: number,
  indent: string,
): boolean {
  // Any acceptable site rule serves; the parser's placement does not depend
  // on which one it is.
  const directive = `${indent}<!-- ${ACCEPTANCE_DIRECTIVE} deno-command -->`;
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
 * sidecar cannot name, or a source line a comment cannot go above (absent
 * from the file's {@link CommentSites} in `sites`). A Markdown line no
 * comment can go above, inside a fenced code block, takes a sidecar entry
 * naming the line. `finding.file` is the absolute path findings carry.
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
  if (indent === undefined) {
    // A Markdown line inside a fenced code block or a multi-line HTML
    // comment takes no comment above it, so the sidecar names the line.
    if (form !== "html" || sites[finding.file] === undefined) return undefined;
    const rel = relative(manifestDir, finding.file);
    if (escapesDir(rel)) return undefined;
    return {
      form: "sidecar",
      file: sidecarFile,
      entry: {
        rule: finding.ruleId,
        file: rel.replaceAll("\\", "/"),
        line: finding.line,
      },
    };
  }
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

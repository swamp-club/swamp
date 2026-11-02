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

import {
  parseExtensionModule,
  type SourceSpan,
} from "@swamp-club/extension-scoring/source";
import { LineIndex } from "./extension_source_ast.ts";
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
 * an acceptance names one finding by file, rule and line and never widens; a
 * reason may not carry Deno.Command( or a base64 run, so a directive cannot
 * trigger the rule it accepts
 */

export const ACCEPTANCE_DIRECTIVE = "swamp-quality-ignore";

export const MAX_ACCEPTANCE_REASON_LENGTH = 200;

export const MAX_DIRECTIVES_PER_FILE = 50;

const RULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export type AcceptanceTarget =
  | { kind: "line"; file: string; line: number }
  | { kind: "file"; file: string }
  | { kind: "extension" };

export type AcceptanceSource = "inline" | "sidecar" | "generated";

export interface AcceptanceDirective {
  ruleId: string;
  reason?: string;
  target: AcceptanceTarget;
  source: AcceptanceSource;
  declaredAt: { file: string; line: number };
}

export interface InvalidAcceptance {
  file: string;
  line: number;
  text: string;
  problem: string;
}

export interface ParsedDirectives {
  directives: AcceptanceDirective[];
  invalid: InvalidAcceptance[];
}

export type CommentForm = "line" | "html" | "none";

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

const BASE64_RUN = /[A-Za-z0-9+/=]{100,}/;

/**
 * the reason must not carry what the line checks match (long lines, base64,
 * Deno.Command( in an unparsed file); a quote is harmless since the parser
 * found the comment
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
 * stacked directives target the same line, allowing one blank line between as a
 * formatter puts after an HTML comment; falls back to the next line, which
 * reads as stale
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

interface DirectiveSite {
  openerAt: number;
  at: number;
  end: number;
  inBlock?: true;
}

interface FileDirectiveSites {
  sites: Map<number, DirectiveSite>;
  parsed: boolean;
}

/**
 * source is read from Babel comments, so the keyword in a string, template or
 * regex is never a directive; markdown is read outside fenced code blocks
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

function parseSource(
  content: string,
  file: string,
  tokens: boolean,
): { tokens: SourceSpan[]; comments: SourceSpan[] } | null {
  const parsed = parseExtensionModule(content, { path: file, tokens });
  return parsed.ok
    ? { tokens: parsed.tokens, comments: parsed.comments }
    : null;
}

/**
 * a multi-line block comment is documentation; lines count by \n alone and a
 * line comment ends where Babel ends it, so a \r or U+2028 after it is not part
 * of the directive
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

function isStandaloneSite(
  lines: string[],
  sites: ReadonlyMap<number, DirectiveSite>,
  lineNumber: number,
): boolean {
  const site = sites.get(lineNumber);
  return site !== undefined &&
    lines[lineNumber - 1].slice(0, site.openerAt).trim().length === 0;
}

export interface DirectiveSpan {
  start: number;
  end: number;
}

/**
 * the one definition of where a directive sits: the parser reads it here and
 * the safety analyzer drops exactly this text before the long-line count, so a
 * directive never triggers the rule it accepts
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

export function withoutDirective(
  line: string,
  span: DirectiveSpan | undefined,
): string {
  if (span === undefined) return line;
  return line.slice(0, span.start) + line.slice(span.end);
}

export interface AcceptableFinding {
  ruleId: string;
  file: string;
  line?: number;
}

export interface AcceptedFinding<T extends AcceptableFinding> {
  finding: T;
  reason?: string;
  source: AcceptanceSource;
  declaredAt: { file: string; line: number };
}

export interface AppliedAcceptances<T extends AcceptableFinding> {
  remaining: T[];
  accepted: AcceptedFinding<T>[];
  stale: AcceptanceDirective[];
}

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
 * a generated declaration is never returned as stale: it is about the package,
 * not one finding
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

export const ACCEPTANCE_POSITIONS = [
  "line-above",
  "file-header",
] as const;

export type AcceptancePosition = typeof ACCEPTANCE_POSITIONS[number];

export interface SidecarAcceptanceEntry {
  rule: string;
  file?: string;
  line?: number;
}

export type Acceptance =
  | {
    form: "comment";
    file: string;
    line: number;
    position: AcceptancePosition;
    text: string;
  }
  | {
    form: "sidecar";
    file: string;
    entry: SidecarAcceptanceEntry;
  };

/**
 * mirrors QUALITY_SIDECAR_FILENAME in extension_quality_sidecar.ts, which
 * imports this module
 */
const SIDECAR_FILENAME = "quality.yaml";

function escapesDir(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + SEPARATOR) || isAbsolute(rel);
}

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
 * a line is absent when it begins inside a multi-line string, template, block
 * comment or markdown fence, where a comment is ignored or changes the program;
 * all are absent when the file does not parse
 */
export type CommentSites = Record<number, string>;

export function commentSites(
  content: string,
  file: string,
  lines: readonly number[],
): CommentSites {
  const text = content.split("\n");
  const barriers = new Set<number>();
  const form = commentFormFor(file);
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
 * an inserted line comment aims at line unless line is itself a standalone
 * directive, which a stack skips; it is read unless earlier directives already
 * reach the cap
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
 * the parser's fence and comment handling can disagree with the barriers, and
 * an offered acceptance must take effect
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
 * a markdown line no comment can go above, inside a fenced block, takes a
 * sidecar entry naming the line; a collapsed finding standing for several files
 * has none
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

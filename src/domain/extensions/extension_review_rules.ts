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

import { extname, join } from "@std/path";
import { z } from "zod";
import { remediationFor } from "./extension_rule_catalog.ts";
import {
  MARKED_SENSITIVE,
  namesSecretValue,
} from "@swamp-club/extension-scoring/secret-docs";
import {
  type AstNode,
  child,
  isCall,
  isMember,
  isNode,
  LineIndex,
  literalKey,
  parseExtensionSource,
  str,
  TS_WRAPPERS,
  unwrap,
  walkRuntimeNodes,
} from "./extension_source_ast.ts";

/**
 * the mechanically decidable floor, not the adversarial review: critical and
 * high findings block the push, medium and low warn; judgment checks stay with
 * the adversarial review
 */

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export type ExtensionContentKind =
  | "model"
  | "vault"
  | "datastore"
  | "report"
  | "webhook";

export interface ReviewSource {
  path: string;
  kind: ExtensionContentKind;
  content: string;
  isEntryPoint: boolean;
  hasSiblingTest: boolean;
}

export interface ReviewFinding {
  ruleId: string;
  dimension: string;
  severity: ReviewSeverity;
  file: string;
  /**
   * absent for file-level and extension-level findings; with file and ruleId it
   * is the identity a declared acceptance names
   */
  line?: number;
  message: string;
  remediation?: string;
  /**
   * set only on the once-per-extension testing-completeness finding, listing
   * entry points without a sibling test so each can be accepted on its own
   */
  files?: string[];
  /**
   * set only on the missing-report finding so JSON consumers get it as an
   * object instead of parsing message
   */
  skeleton?: ReviewReportSkeleton;
}

export interface RuleDetection {
  message: string;
  line?: number;
}

export interface ReviewRule {
  id: string;
  dimension: string;
  severity: ReviewSeverity;
  appliesTo: ExtensionContentKind[];
  /**
   * pure; one entry per issue found, empty means the file passes; the framework
   * attaches id, dimension, severity and remediation
   */
  detect: (source: ReviewSource) => Array<string | RuleDetection>;
}

export interface ReviewRulesResult {
  errors: ReviewFinding[];
  warnings: ReviewFinding[];
  passed: boolean;
}

export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return severity === "critical" || severity === "high";
}

/**
 * not a full tokenizer: block comments and string-literal occurrences of // are
 * not handled
 */
function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * known limit: text shaped like `, token:` inside a string literal on the same
 * line also matches
 */
const KEY_IDENTIFIER =
  /(?:^|[{,(])\s*(?:([A-Za-z_$][\w$]*)|"([^"]+)"|'([^']+)')\s*(?:\?\s*)?:/g;

/** the (?!=) keeps == comparisons out */
const DECLARED_IDENTIFIER =
  /^\s*(?:(?:export|declare|public|private|protected|static|readonly|const|let|var)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=(?!=)/;

function declaredIdentifiers(line: string): string[] {
  const identifiers: string[] = [];
  for (const match of line.matchAll(KEY_IDENTIFIER)) {
    identifiers.push(match[1] ?? match[2] ?? match[3]);
  }
  const declared = DECLARED_IDENTIFIER.exec(line);
  if (declared) identifiers.push(declared[1]);
  return identifiers;
}

/**
 * z.coerce. is accepted only before numeric, date or boolean types: it changes
 * what parses, not the parsed type, so z.coerce.string() stays flagged
 */
const NON_SECRET_ZOD_TYPE =
  /\bz\s*\.\s*(?:(?:number|boolean|literal|object|array|enum|int|int32|uint32|int64|uint64|float32|float64|bigint|date)|coerce\s*\.\s*(?:number|bigint|boolean|date))\s*\(/;

const EMPTY_OBJECT_PASSTHROUGH =
  /z\s*\.\s*object\s*\(\s*\{\s*\}\s*\)\s*\.\s*passthrough\s*\(/;

/** text fallback for a source that does not parse */
function markedOnContinuationLines(lines: string[], index: number): boolean {
  for (let j = index + 1; j < lines.length; j++) {
    const cont = stripLineComment(lines[j]);
    if (!/^\s+\./.test(cont)) return false;
    if (MARKED_SENSITIVE.test(cont)) return true;
  }
  return false;
}

const FIELD_NODES = new Set([
  "ObjectProperty",
  "ClassProperty",
  "VariableDeclarator",
]);

function fieldName(node: AstNode): string | undefined {
  const key = child(node, node.type === "VariableDeclarator" ? "id" : "key");
  if (key?.type === "Identifier") {
    return node.computed === true ? undefined : str(key, "name");
  }
  return literalKey(key);
}

function childList(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function isSensitiveEntry(node: AstNode): boolean {
  const value = unwrap(child(node, "value"));
  return node.type === "ObjectProperty" && fieldName(node) === "sensitive" &&
    value?.type === "BooleanLiteral" && value.value === true;
}

/**
 * checks only an object literal's direct entries, so a nested field's metadata
 * never marks the field holding it; the stack is explicit because extension
 * source is untrusted
 */
function carriesSensitiveMarker(value: AstNode): boolean {
  const stack: AstNode[] = [value];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "ObjectExpression") {
      if (childList(node, "properties").some(isSensitiveEntry)) return true;
    } else if (isCall(node)) {
      const callee = child(node, "callee");
      if (callee) stack.push(callee);
      for (const argument of childList(node, "arguments")) {
        stack.push(argument);
      }
    } else if (isMember(node)) {
      const object = child(node, "object");
      if (object) stack.push(object);
    } else if (TS_WRAPPERS.has(node.type)) {
      const expression = child(node, "expression");
      if (expression) stack.push(expression);
    } else if (node.type === "ArrayExpression") {
      for (const element of childList(node, "elements")) stack.push(element);
    }
  }
  return false;
}

function isZodChain(value: AstNode | undefined): value is AstNode {
  let current = unwrap(value);
  while (current) {
    if (isCall(current)) current = unwrap(child(current, "callee"));
    else if (isMember(current)) current = unwrap(child(current, "object"));
    else return current.type === "Identifier" && str(current, "name") === "z";
  }
  return false;
}

function parsedSensitiveFields(
  source: ReviewSource,
): Map<number, boolean> | null {
  const program = parseExtensionSource(source.content, { path: source.path });
  if (!program) return null;
  const lineIndex = new LineIndex(source.content);
  const marked = new Map<number, boolean>();
  walkRuntimeNodes(program, ({ node }) => {
    if (!FIELD_NODES.has(node.type)) return;
    const name = fieldName(node);
    if (name === undefined || !namesSecretValue(name)) return;
    const isDeclarator = node.type === "VariableDeclarator";
    const start = child(node, isDeclarator ? "id" : "key")?.start;
    if (typeof start !== "number") return;
    const value = child(node, isDeclarator ? "init" : "value");
    // Only a schema declares a field. A destructured name, a shorthand or
    // variable value, or a key in a callback's object literal is left to the
    // line check, so it cannot cancel a marker on the field beside it.
    if (!isZodChain(value)) return;
    const line = lineIndex.position(start).line;
    marked.set(
      line,
      (marked.get(line) ?? true) && carriesSensitiveMarker(value),
    );
  });
  return marked;
}

/**
 * all starter rules are non-blocking: no mechanical pattern is an unambiguous
 * hard rule (even .passthrough() is legitimate when properties are declared)
 */
export const DEFAULT_REVIEW_RULES: ReviewRule[] = [
  {
    id: "schema-strictness",
    dimension: "Schema strictness",
    severity: "medium",
    appliesTo: ["model"],
    detect: (source) => {
      const detections: RuleDetection[] = [];
      const lines = source.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (EMPTY_OBJECT_PASSTHROUGH.test(stripLineComment(lines[i]))) {
          detections.push({
            line: i + 1,
            message:
              "Uses `z.object({}).passthrough()` with no declared properties — " +
              "CEL expressions cannot validate against an empty schema. Declare " +
              "the referenced properties explicitly.",
          });
        }
      }
      return detections;
    },
  },
  {
    id: "testing-completeness",
    dimension: "Testing Completeness",
    severity: "medium",
    appliesTo: ["model", "vault", "datastore", "report", "webhook"],
    detect: (source) => {
      if (!source.isEntryPoint) return [];
      if (source.path.endsWith("_test.ts")) return [];
      if (source.hasSiblingTest) return [];
      return [
        "No sibling `_test.ts` found — cover both success and failure paths " +
        "with unit tests before publishing.",
      ];
    },
  },
  {
    id: "credentials-sensitive-field",
    dimension: "Credentials & Secrets",
    severity: "medium",
    appliesTo: ["model", "vault"],
    detect: (source) => {
      const detections: RuleDetection[] = [];
      const lines = source.content.split("\n");
      let parsed: Map<number, boolean> | null | undefined;
      for (let i = 0; i < lines.length; i++) {
        const line = stripLineComment(lines[i]);
        if (!/z\s*\./.test(line)) continue;
        if (!declaredIdentifiers(line).some(namesSecretValue)) continue;

        if (NON_SECRET_ZOD_TYPE.test(line)) continue;

        if (MARKED_SENSITIVE.test(line)) continue;

        // The syntax tree decides when it has a secret field on this line,
        // so a wrapped `.meta({ ... })` counts and string text does not.
        if (parsed === undefined) parsed = parsedSensitiveFields(source);
        const parsedMarked = parsed?.get(i + 1);
        if (parsedMarked === true) continue;

        if (
          parsedMarked === undefined && markedOnContinuationLines(lines, i)
        ) continue;

        detections.push({
          line: i + 1,
          message:
            `Field on line "${line.trim()}" looks like a secret but is not ` +
            "marked `.meta({ sensitive: true })`. Sensitive values must be " +
            "vaulted.",
        });
      }
      return detections;
    },
  },
];

export function evaluateReviewRules(
  sources: ReviewSource[],
  rules: ReviewRule[] = DEFAULT_REVIEW_RULES,
): ReviewRulesResult {
  const errors: ReviewFinding[] = [];
  const warnings: ReviewFinding[] = [];

  for (const source of sources) {
    for (const rule of rules) {
      if (!rule.appliesTo.includes(source.kind)) continue;
      for (const detected of rule.detect(source)) {
        const detection: RuleDetection = typeof detected === "string"
          ? { message: detected }
          : detected;
        const remediation = remediationFor(rule.id);
        const finding: ReviewFinding = {
          ruleId: rule.id,
          dimension: rule.dimension,
          severity: rule.severity,
          file: source.path,
          ...(detection.line !== undefined ? { line: detection.line } : {}),
          message: detection.message,
          ...(remediation !== undefined ? { remediation } : {}),
        };
        if (isBlockingSeverity(rule.severity)) {
          errors.push(finding);
        } else {
          warnings.push(finding);
        }
      }
    }
  }

  return { errors, warnings, passed: errors.length === 0 };
}

/**
 * the report path is bound to the content hash: editing any source changes it,
 * so a stale review is not found and re-blocks the push
 */

export interface ReviewDimension {
  id: string;
  label: string;
  appliesTo: ExtensionContentKind[] | "all";
}

export const REVIEW_DIMENSIONS: ReviewDimension[] = [
  {
    id: "credentials-secrets",
    label: "Credentials & Secrets",
    appliesTo: "all",
  },
  { id: "logging-quality", label: "Logging Quality", appliesTo: "all" },
  { id: "error-handling", label: "Error Handling", appliesTo: "all" },
  {
    id: "testing-completeness",
    label: "Testing Completeness",
    appliesTo: "all",
  },
  {
    id: "idempotency-resilience",
    label: "Idempotency & Resilience",
    appliesTo: "all",
  },
  { id: "api-contracts", label: "API Contracts", appliesTo: "all" },
  { id: "resource-management", label: "Resource Management", appliesTo: "all" },
  {
    id: "published-surface-hygiene",
    label: "Published-Surface Hygiene",
    appliesTo: "all",
  },
  { id: "schema-strictness", label: "Schema strictness", appliesTo: ["model"] },
  { id: "lifetime-gc", label: "Lifetime & GC", appliesTo: ["model"] },
  { id: "crud-completeness", label: "CRUD completeness", appliesTo: ["model"] },
  { id: "preflight-checks", label: "Pre-flight checks", appliesTo: ["model"] },
  { id: "instance-names", label: "Instance names", appliesTo: ["model"] },
  { id: "data-access", label: "Data access", appliesTo: ["model"] },
  { id: "version-upgrades", label: "Version upgrades", appliesTo: ["model"] },
  { id: "vault-get-throws", label: "Vault get throws", appliesTo: ["vault"] },
  {
    id: "vault-put-idempotent",
    label: "Vault put idempotent",
    appliesTo: ["vault"],
  },
  {
    id: "vault-list-keys-only",
    label: "Vault list keys only",
    appliesTo: ["vault"],
  },
  { id: "vault-getname", label: "Vault getName", appliesTo: ["vault"] },
  {
    id: "datastore-createlock",
    label: "Datastore createLock",
    appliesTo: ["datastore"],
  },
  {
    id: "datastore-withlock-release",
    label: "Datastore withLock release",
    appliesTo: ["datastore"],
  },
  {
    id: "datastore-verifier",
    label: "Datastore verifier",
    appliesTo: ["datastore"],
  },
  {
    id: "datastore-path-deterministic",
    label: "Datastore path deterministic",
    appliesTo: ["datastore"],
  },
  {
    id: "datastore-cachepath",
    label: "Datastore cachePath",
    appliesTo: ["datastore"],
  },
];

export function applicableDimensions(
  kinds: ExtensionContentKind[],
): ReviewDimension[] {
  const present = new Set(kinds);
  return REVIEW_DIMENSIONS.filter((d) =>
    d.appliesTo === "all" || d.appliesTo.some((k) => present.has(k))
  );
}

export const REVIEW_VERDICT_VALUES = [
  "pass",
  "issue",
  "na",
  "pending",
] as const;

const ReviewVerdictSchema = z.enum(REVIEW_VERDICT_VALUES);

const ExtensionReviewReportSchema = z.object({
  extension: z.string(),
  version: z.string(),
  reviewedAt: z.string(),
  dimensions: z.array(z.object({
    id: z.string(),
    verdict: ReviewVerdictSchema,
    note: z.string().optional(),
  })),
});

export type ExtensionReviewReport = z.infer<typeof ExtensionReviewReportSchema>;

export type ReviewReportParseResult =
  | { ok: true; report: ExtensionReviewReport }
  | { ok: false; errors: string[] }
  | null;

export function parseReviewReport(raw: string): ReviewReportParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ExtensionReviewReportSchema.safeParse(parsed);
  if (result.success) {
    return { ok: true, report: result.data };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, errors };
}

function reviewBaseDir(): string {
  return Deno.env.get("SWAMP_EXTENSION_REVIEW_DIR") ??
    Deno.env.get("TMPDIR") ?? Deno.env.get("TMP") ??
    Deno.env.get("TEMP") ??
    "/tmp";
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * the full content hash is the uniqueness key, so names colliding under
 * sanitizeName still do not clash; any source change yields a new path, so an
 * earlier review does not satisfy the gate
 */
export function reviewReportPath(
  extensionName: string,
  contentHash: string,
  baseTmpDir: string = reviewBaseDir(),
): string {
  return join(
    baseTmpDir,
    "swamp-extension-review",
    `${sanitizeName(extensionName)}-${contentHash}.json`,
  );
}

export interface ReviewReportSkeleton {
  extension: string;
  version: string;
  reviewedAt: string;
  dimensions: { id: string; verdict: "pending"; note: string }[];
}

export function buildReviewReportSkeleton(
  extensionName: string,
  extensionVersion: string,
  dimensions: ReviewDimension[],
): ReviewReportSkeleton {
  return {
    extension: extensionName,
    version: extensionVersion,
    reviewedAt: "<ISO-8601 timestamp>",
    dimensions: dimensions.map((d) => ({
      id: d.id,
      verdict: "pending",
      note: "",
    })),
  };
}

export interface ReviewReportContext {
  report: ExtensionReviewReport | null;
  parseErrors?: string[];
  reportPath: string;
  extensionName: string;
  extensionVersion: string;
  applicableDimensions: ReviewDimension[];
  skeleton: ReviewReportSkeleton;
}

const REVIEW_REPORT_RULE = "adversarial-review-report";
/**
 * separate from REVIEW_REPORT_RULE so a gate keyed on that passes a complete
 * review whatever its verdicts, and an honest issue verdict is not read as a
 * missing review
 */
const REVIEW_ISSUE_VERDICT_RULE = "adversarial-review-dimension-issue";
const REVIEW_REPORT_DIMENSION = "Adversarial review";

/**
 * findings are medium warnings, not hard blocks: a version bump with no code
 * change alters the content hash and should only nudge the reviewer
 */
export function evaluateReviewReport(
  ctx: ReviewReportContext,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const gate: ReviewSeverity = "medium";

  if (ctx.parseErrors && ctx.parseErrors.length > 0) {
    const allowed = REVIEW_VERDICT_VALUES.join(", ");
    findings.push({
      ruleId: REVIEW_REPORT_RULE,
      dimension: REVIEW_REPORT_DIMENSION,
      severity: gate,
      file: ctx.reportPath,
      message:
        `Review report has invalid content — ${ctx.parseErrors.join("; ")}. ` +
        `Allowed verdict values: ${allowed}.`,
    });
    return findings;
  }

  if (!ctx.report) {
    findings.push({
      ruleId: REVIEW_REPORT_RULE,
      dimension: REVIEW_REPORT_DIMENSION,
      severity: gate,
      file: ctx.reportPath,
      // single-line message; the skeleton rides its own field for JSON
      // consumers
      message:
        "No adversarial review recorded for the current code — perform the " +
        "review and write the report here (run with --dry-run --json for the " +
        "fill-in skeleton, or see the swamp skill).",
      skeleton: ctx.skeleton,
    });
    return findings;
  }

  if (
    ctx.report.extension !== ctx.extensionName ||
    ctx.report.version !== ctx.extensionVersion
  ) {
    findings.push({
      ruleId: REVIEW_REPORT_RULE,
      dimension: REVIEW_REPORT_DIMENSION,
      severity: gate,
      file: ctx.reportPath,
      message:
        `Review report is for ${ctx.report.extension}@${ctx.report.version}, ` +
        `but this push is ${ctx.extensionName}@${ctx.extensionVersion}.`,
    });
  }

  const byId = new Map(ctx.report.dimensions.map((d) => [d.id, d]));
  const missing: string[] = [];
  const pending: string[] = [];
  for (const d of ctx.applicableDimensions) {
    const entry = byId.get(d.id);
    if (!entry) {
      missing.push(d.id);
    } else if (entry.verdict === "pending") {
      pending.push(d.id);
    }
  }
  if (missing.length > 0) {
    findings.push({
      ruleId: REVIEW_REPORT_RULE,
      dimension: REVIEW_REPORT_DIMENSION,
      severity: gate,
      file: ctx.reportPath,
      message: `Review report is missing verdicts for: ${missing.join(", ")}.`,
    });
  }
  if (pending.length > 0) {
    findings.push({
      ruleId: REVIEW_REPORT_RULE,
      dimension: REVIEW_REPORT_DIMENSION,
      severity: gate,
      file: ctx.reportPath,
      message: `Review report still has pending verdicts for: ${
        pending.join(", ")
      }.`,
    });
  }

  for (const entry of ctx.report.dimensions) {
    if (entry.verdict === "issue") {
      findings.push({
        // distinct ruleId so a gate on REVIEW_REPORT_RULE treats a completed
        // review as clean whatever its verdict; file points at the review,
        // where the note lives
        ruleId: REVIEW_ISSUE_VERDICT_RULE,
        dimension: REVIEW_REPORT_DIMENSION,
        severity: "medium",
        file: ctx.reportPath,
        message: `Dimension ${entry.id} flagged ISSUE${
          entry.note ? `: ${entry.note}` : ""
        }.`,
      });
    }
  }

  return findings;
}

export interface ReviewFileRef {
  path: string;
  kind: ExtensionContentKind;
  isEntryPoint: boolean;
}

export type ReviewReportRequest = Omit<ReviewReportContext, "report">;

export interface ExtensionReviewInput {
  files: ReviewFileRef[];
  report?: ReviewReportRequest;
}

export interface ReviewRulesIo {
  readTextFile: (path: string) => Promise<string>;
  fileExists: (path: string) => Promise<boolean>;
}

const DEFAULT_IO: ReviewRulesIo = {
  readTextFile: (path) => Deno.readTextFile(path),
  fileExists: async (path) => {
    try {
      const info = await Deno.stat(path);
      return info.isFile;
    } catch {
      return false;
    }
  },
};

function siblingTestPath(path: string): string {
  const ext = extname(path);
  const base = path.slice(0, path.length - ext.length);
  return `${base}_test${ext}`;
}

/**
 * files that cannot be read are skipped; the safety analyzer's read check
 * surfaces them
 */
export async function checkReviewRules(
  input: ExtensionReviewInput,
  rules: ReviewRule[] = DEFAULT_REVIEW_RULES,
  io: ReviewRulesIo = DEFAULT_IO,
): Promise<ReviewRulesResult> {
  const sources: ReviewSource[] = [];

  for (const ref of input.files) {
    if (extname(ref.path) !== ".ts") continue;
    if (ref.path.endsWith("_test.ts")) continue;

    let content: string;
    try {
      content = await io.readTextFile(ref.path);
    } catch {
      continue;
    }

    const hasSiblingTest = await io.fileExists(siblingTestPath(ref.path));

    sources.push({
      path: ref.path,
      kind: ref.kind,
      content,
      isEntryPoint: ref.isEntryPoint,
      hasSiblingTest,
    });
  }

  const fileResult = evaluateReviewRules(sources, rules);
  const findings: ReviewFinding[] = [
    ...fileResult.errors,
    ...fileResult.warnings,
  ];

  if (input.report) {
    let raw: string | null = null;
    try {
      raw = await io.readTextFile(input.report.reportPath);
    } catch {
      raw = null;
    }
    let report: ExtensionReviewReport | null = null;
    let parseErrors: string[] | undefined;
    if (raw !== null) {
      const parsed = parseReviewReport(raw);
      if (parsed === null) {
        report = null;
      } else if (parsed.ok) {
        report = parsed.report;
      } else {
        parseErrors = parsed.errors;
      }
    }
    for (
      const finding of evaluateReviewReport({
        ...input.report,
        report,
        parseErrors,
      })
    ) {
      const remediation = remediationFor(finding.ruleId);
      findings.push(
        remediation === undefined ? finding : { ...finding, remediation },
      );
    }
  }

  const errors = findings.filter((f) => isBlockingSeverity(f.severity));
  const warnings = findings.filter((f) => !isBlockingSeverity(f.severity));
  return { errors, warnings, passed: errors.length === 0 };
}

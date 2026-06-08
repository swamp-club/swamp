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

/**
 * Deterministic, push-time static rules for extensions.
 *
 * IMPORTANT: this is NOT the adversarial review. The adversarial review is a
 * judgment pass performed by an AI agent (and by the CI
 * `claude-adversarial-review` action) that reasons about intent across all
 * dimensions — idempotency, API contracts, error-before-write, resource
 * cleanup, and so on. Those cannot be decided by a static scan.
 *
 * This ruleset only enforces the small, mechanically-decidable floor (e.g.
 * an empty-object `.passthrough()`, a missing sibling test, an unmarked
 * sensitive field). It runs at push time exactly like the dependency-trust
 * audit: findings carry a severity and the result partitions by it —
 * `critical`/`high` block the push, `medium`/`low` only warn. It complements
 * the adversarial review; it does not replace it.
 *
 * New checks are added as {@link ReviewRule} entries in
 * {@link DEFAULT_REVIEW_RULES}. Each rule is self-contained: it declares the
 * adversarial-review dimension it relates to (see
 * `.claude/skills/swamp/references/extension/references/adversarial-review.md`), the
 * content kinds it inspects, its severity, and a pure detector.
 */

/** Severity of a review-rule finding. Mirrors the CI review scale. */
export type ReviewSeverity = "critical" | "high" | "medium" | "low";

/** The extension content kinds a rule can inspect. */
export type ExtensionContentKind =
  | "model"
  | "vault"
  | "driver"
  | "datastore"
  | "report";

/** A single source file presented to the ruleset. */
export interface ReviewSource {
  /** Absolute path of the source file. */
  path: string;
  /** Which content kind this file belongs to. */
  kind: ExtensionContentKind;
  /** File contents. */
  content: string;
  /** Whether this file is an entry point (the main implementation file). */
  isEntryPoint: boolean;
  /** Whether a sibling `<base>_test.ts` exists for this file. */
  hasSiblingTest: boolean;
}

/** A finding emitted by a rule against a single source file. */
export interface ReviewFinding {
  /** The id of the rule that produced this finding. */
  ruleId: string;
  /** The adversarial-review dimension this rule relates to. */
  dimension: string;
  /** Severity — determines whether the finding blocks or only warns. */
  severity: ReviewSeverity;
  /** Absolute path of the offending file. */
  file: string;
  /** Actionable description of the issue. */
  message: string;
  /**
   * Optional fill-in report skeleton (JSON). Set only on the missing-report
   * finding so JSON consumers get it as a discrete field rather than parsing
   * it out of `message`.
   */
  skeleton?: string;
}

/**
 * A single review rule. Add new rules to {@link DEFAULT_REVIEW_RULES} to grow
 * the enforced set.
 */
export interface ReviewRule {
  /** Stable identifier, e.g. `schema-strictness`. */
  id: string;
  /** The adversarial-review dimension this rule relates to. */
  dimension: string;
  /** Severity assigned to every finding this rule emits. */
  severity: ReviewSeverity;
  /** Content kinds this rule inspects. */
  appliesTo: ExtensionContentKind[];
  /**
   * Pure detector. Returns one message per issue found in `source`; an
   * empty array means the file passes this rule. The framework attaches the
   * rule's id, dimension, and severity.
   */
  detect: (source: ReviewSource) => string[];
}

/** Result of running the ruleset over a set of sources. */
export interface ReviewRulesResult {
  /** Findings whose severity is `critical` or `high` — these block the push. */
  errors: ReviewFinding[];
  /** Findings whose severity is `medium` or `low` — these only warn. */
  warnings: ReviewFinding[];
  /** True when there are no blocking (error) findings. */
  passed: boolean;
}

/** Returns true when a severity blocks the push. */
export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return severity === "critical" || severity === "high";
}

// ── Detection helpers ─────────────────────────────────────────────────

/**
 * Strips `//` line comments from a single source line so detectors don't
 * fire on commented-out code. Not a full tokenizer — block comments and
 * string-literal occurrences are out of scope for this first cut.
 */
function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * Substrings that, in a field name, strongly suggest a secret value. Matched
 * without word boundaries so camelCase fields like `apiToken` are caught.
 */
const SENSITIVE_FIELD_PATTERN =
  /password|passwd|secret|token|api[_-]?key|access[_-]?key|credential|private[_-]?key/i;

/** Matches `z.object({}).passthrough()` — an empty-object passthrough. */
const EMPTY_OBJECT_PASSTHROUGH =
  /z\s*\.\s*object\s*\(\s*\{\s*\}\s*\)\s*\.\s*passthrough\s*\(/;

// ── Default ruleset ───────────────────────────────────────────────────

/**
 * The default review ruleset. All starter rules are non-blocking
 * (`medium`/`low`) — none of the mechanical patterns is an unambiguous hard
 * rule (the skill phrases every dimension as "should", and even
 * `.passthrough()` is legitimate when properties are declared). The severity
 * machinery still routes any future `critical`/`high` rule to the blocking
 * path. Append new rules here.
 */
export const DEFAULT_REVIEW_RULES: ReviewRule[] = [
  {
    id: "schema-strictness",
    dimension: "Schema strictness",
    severity: "medium",
    appliesTo: ["model"],
    detect: (source) => {
      const messages: string[] = [];
      const lines = source.content.split("\n");
      for (const line of lines) {
        if (EMPTY_OBJECT_PASSTHROUGH.test(stripLineComment(line))) {
          messages.push(
            "Uses `z.object({}).passthrough()` with no declared properties — " +
              "CEL expressions cannot validate against an empty schema. Declare " +
              "the referenced properties explicitly.",
          );
        }
      }
      return messages;
    },
  },
  {
    id: "testing-completeness",
    dimension: "Testing Completeness",
    severity: "medium",
    appliesTo: ["model", "vault", "driver", "datastore", "report"],
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
      const messages: string[] = [];
      const lines = source.content.split("\n");
      for (const raw of lines) {
        const line = stripLineComment(raw);
        // Heuristic: a schema field whose name suggests a secret, declared
        // with a zod type, but not marked sensitive on the same line.
        if (
          SENSITIVE_FIELD_PATTERN.test(line) &&
          /z\s*\./.test(line) &&
          !/sensitive/i.test(line)
        ) {
          messages.push(
            `Field on line "${line.trim()}" looks like a secret but is not ` +
              "marked `.meta({ sensitive: true })`. Sensitive values must be " +
              "vaulted.",
          );
        }
      }
      return messages;
    },
  },
  {
    id: "driver-log-forwarding",
    dimension: "Logging Quality",
    severity: "low",
    appliesTo: ["driver"],
    detect: (source) => {
      if (!source.isEntryPoint) return [];
      if (source.content.includes("onLog")) return [];
      return [
        "Driver does not forward logs to the host via `callbacks.onLog()` — " +
        "host-side observability of driver execution will be limited.",
      ];
    },
  },
];

// ── Pure evaluator ────────────────────────────────────────────────────

/**
 * Runs `rules` over `sources` and partitions findings by severity.
 * Pure and synchronous — all I/O is the caller's responsibility.
 */
export function evaluateReviewRules(
  sources: ReviewSource[],
  rules: ReviewRule[] = DEFAULT_REVIEW_RULES,
): ReviewRulesResult {
  const errors: ReviewFinding[] = [];
  const warnings: ReviewFinding[] = [];

  for (const source of sources) {
    for (const rule of rules) {
      if (!rule.appliesTo.includes(source.kind)) continue;
      for (const message of rule.detect(source)) {
        const finding: ReviewFinding = {
          ruleId: rule.id,
          dimension: rule.dimension,
          severity: rule.severity,
          file: source.path,
          message,
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

// ── Adversarial-review report ─────────────────────────────────────────

/**
 * The adversarial review itself (the agent/CI judgment pass) records its
 * verdicts to a report at a content-hash-bound tmp path. The push gate
 * verifies that report exists, matches the current code, and is complete —
 * making the review a non-optional step. Editing any source changes the
 * content hash, which changes the report path, so a stale review is simply
 * "not found" and re-blocks the push.
 */

/** A review dimension from the adversarial-review skill reference. */
export interface ReviewDimension {
  /** Stable identifier, e.g. `credentials-secrets`. */
  id: string;
  /** Human label matching the skill reference. */
  label: string;
  /** Content kinds this dimension applies to, or "all" for universal. */
  appliesTo: ExtensionContentKind[] | "all";
}

/**
 * The catalog of adversarial-review dimensions. Single source of truth,
 * mirroring `.claude/skills/swamp/references/extension/references/adversarial-review.md`.
 */
export const REVIEW_DIMENSIONS: ReviewDimension[] = [
  // Universal
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
  // Models
  { id: "schema-strictness", label: "Schema strictness", appliesTo: ["model"] },
  { id: "lifetime-gc", label: "Lifetime & GC", appliesTo: ["model"] },
  { id: "crud-completeness", label: "CRUD completeness", appliesTo: ["model"] },
  { id: "preflight-checks", label: "Pre-flight checks", appliesTo: ["model"] },
  { id: "instance-names", label: "Instance names", appliesTo: ["model"] },
  { id: "data-access", label: "Data access", appliesTo: ["model"] },
  { id: "version-upgrades", label: "Version upgrades", appliesTo: ["model"] },
  // Drivers
  {
    id: "driver-output-kind",
    label: "Driver output kind",
    appliesTo: ["driver"],
  },
  { id: "driver-duration", label: "Driver durationMs", appliesTo: ["driver"] },
  {
    id: "driver-log-forwarding",
    label: "Driver log forwarding",
    appliesTo: ["driver"],
  },
  { id: "driver-lifecycle", label: "Driver lifecycle", appliesTo: ["driver"] },
  {
    id: "driver-error-status",
    label: "Driver error status",
    appliesTo: ["driver"],
  },
  // Vaults
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
  // Datastores
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

/** Returns the dimensions applicable to the content kinds present. */
export function applicableDimensions(
  kinds: ExtensionContentKind[],
): ReviewDimension[] {
  const present = new Set(kinds);
  return REVIEW_DIMENSIONS.filter((d) =>
    d.appliesTo === "all" || d.appliesTo.some((k) => present.has(k))
  );
}

/** A per-dimension verdict recorded by the reviewer. */
const ReviewVerdictSchema = z.enum(["pass", "issue", "na", "pending"]);

/** Schema for the on-disk adversarial-review report. */
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

/** The on-disk adversarial-review report. */
export type ExtensionReviewReport = z.infer<typeof ExtensionReviewReportSchema>;

/** Parses report JSON, returning null when missing or malformed. */
export function parseReviewReport(raw: string): ExtensionReviewReport | null {
  try {
    const result = ExtensionReviewReportSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
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
 * Content-hash-bound path of the adversarial-review report. The full content
 * hash in the filename binds the report to the exact code and is the real
 * uniqueness key — the content hash already encodes the manifest name, so even
 * if the human-readable name prefix collides under `sanitizeName` (e.g. `@a/b`
 * vs `@a_b`), the hashes differ and the files do not clash. Any source change
 * yields a different path, so a prior review no longer satisfies the gate.
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

/** Builds a fill-in-the-blanks report skeleton for the given dimensions. */
export function buildReviewReportSkeleton(
  extensionName: string,
  extensionVersion: string,
  dimensions: ReviewDimension[],
): string {
  return JSON.stringify(
    {
      extension: extensionName,
      version: extensionVersion,
      reviewedAt: "<ISO-8601 timestamp>",
      dimensions: dimensions.map((d) => ({
        id: d.id,
        verdict: "pending",
        note: "",
      })),
    },
    null,
    2,
  );
}

/** Context for evaluating the adversarial-review report at push time. */
export interface ReviewReportContext {
  /** Parsed report, or null when missing/malformed. */
  report: ExtensionReviewReport | null;
  /** The content-hash-bound path the report was looked up at. */
  reportPath: string;
  /** Expected extension name (from the manifest). */
  extensionName: string;
  /** Expected extension version (from the manifest). */
  extensionVersion: string;
  /** Dimensions that must each carry a non-pending verdict. */
  applicableDimensions: ReviewDimension[];
  /** Skeleton to show the reviewer when the report is missing. */
  skeleton: string;
}

const REVIEW_REPORT_RULE = "adversarial-review-report";
const REVIEW_REPORT_DIMENSION = "Adversarial review";

/**
 * Validates the adversarial-review report against the current code. All
 * report findings are `medium` warnings: at push time they surface a
 * "continue despite warnings?" prompt (bypassable with `--yes`) rather than a
 * hard block — so a manual version bump or other benign hash change nudges the
 * reviewer without bricking the push. A hard block here would punish the common
 * "bumped the version, didn't touch the code" case, since the version is part
 * of the content hash.
 */
export function evaluateReviewReport(
  ctx: ReviewReportContext,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const gate: ReviewSeverity = "medium";

  if (!ctx.report) {
    findings.push({
      ruleId: REVIEW_REPORT_RULE,
      dimension: REVIEW_REPORT_DIMENSION,
      severity: gate,
      file: ctx.reportPath,
      // Single-line, self-sufficient message (the path is the finding's
      // `file`); the skeleton rides on its own field for JSON consumers.
      // `--dry-run --json` is the safe incantation — `--json` alone would
      // bypass the confirmation prompt and push without the review.
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
        ruleId: REVIEW_REPORT_RULE,
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

// ── Async wrapper (reads source from disk) ────────────────────────────

/** A source file to review, before its content has been read. */
export interface ReviewFileRef {
  path: string;
  kind: ExtensionContentKind;
  isEntryPoint: boolean;
}

/**
 * The report lookup request push hands to {@link checkReviewRules}. The
 * parsed report is filled in by the checker after reading from disk.
 */
export type ReviewReportRequest = Omit<ReviewReportContext, "report">;

/** Input to {@link checkReviewRules}: source files plus optional report. */
export interface ExtensionReviewInput {
  /** Source files to run the static file rules over. */
  files: ReviewFileRef[];
  /**
   * When present, the adversarial-review report is also validated. Omitted
   * by non-push callers (e.g. quality packaging) that only need file rules.
   */
  report?: ReviewReportRequest;
}

/** Injectable I/O for {@link checkReviewRules}. */
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

/** Computes the sibling test path for a `.ts` source file. */
function siblingTestPath(path: string): string {
  const ext = extname(path);
  const base = path.slice(0, path.length - ext.length);
  return `${base}_test${ext}`;
}

/**
 * Reads each referenced file, runs the static file rules, and — when a report
 * request is supplied — reads and validates the adversarial-review report.
 * Findings from both are re-partitioned by severity. Files that cannot be read
 * are skipped (they are surfaced by the safety analyzer's read check).
 * Modelled on `checkDependencyTrust`.
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
    const report = raw === null ? null : parseReviewReport(raw);
    findings.push(...evaluateReviewReport({ ...input.report, report }));
  }

  const errors = findings.filter((f) => isBlockingSeverity(f.severity));
  const warnings = findings.filter((f) => !isBlockingSeverity(f.severity));
  return { errors, warnings, passed: errors.length === 0 };
}

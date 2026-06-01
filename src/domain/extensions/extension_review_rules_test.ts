// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assert, assertEquals } from "@std/assert";
import {
  applicableDimensions,
  buildReviewReportSkeleton,
  checkReviewRules,
  DEFAULT_REVIEW_RULES,
  evaluateReviewReport,
  evaluateReviewRules,
  type ExtensionReviewReport,
  isBlockingSeverity,
  parseReviewReport,
  type ReviewDimension,
  reviewReportPath,
  type ReviewRule,
  type ReviewRulesIo,
  type ReviewSource,
} from "./extension_review_rules.ts";

function source(overrides: Partial<ReviewSource>): ReviewSource {
  return {
    path: "/ext/models/thing.ts",
    kind: "model",
    content: "",
    isEntryPoint: true,
    hasSiblingTest: true,
    ...overrides,
  };
}

Deno.test("isBlockingSeverity: critical and high block, others do not", () => {
  assertEquals(isBlockingSeverity("critical"), true);
  assertEquals(isBlockingSeverity("high"), true);
  assertEquals(isBlockingSeverity("medium"), false);
  assertEquals(isBlockingSeverity("low"), false);
});

Deno.test("evaluateReviewRules: clean source produces no findings", () => {
  const result = evaluateReviewRules([
    source({
      content: "export const model = z.object({ id: z.string() });",
    }),
  ]);
  assertEquals(result.errors, []);
  assertEquals(result.warnings, []);
  assertEquals(result.passed, true);
});

Deno.test("evaluateReviewRules: partitions critical/high into errors, medium/low into warnings", () => {
  const rules: ReviewRule[] = [
    {
      id: "always-high",
      dimension: "Test",
      severity: "high",
      appliesTo: ["model"],
      detect: () => ["boom"],
    },
    {
      id: "always-low",
      dimension: "Test",
      severity: "low",
      appliesTo: ["model"],
      detect: () => ["meh"],
    },
  ];
  const result = evaluateReviewRules([source({})], rules);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].ruleId, "always-high");
  assertEquals(result.warnings.length, 1);
  assertEquals(result.warnings[0].ruleId, "always-low");
  assertEquals(result.passed, false);
});

Deno.test("evaluateReviewRules: rule only runs against its declared kinds", () => {
  const rules: ReviewRule[] = [
    {
      id: "vault-only",
      dimension: "Test",
      severity: "low",
      appliesTo: ["vault"],
      detect: () => ["fired"],
    },
  ];
  const onModel = evaluateReviewRules([source({ kind: "model" })], rules);
  assertEquals(onModel.warnings.length, 0);
  const onVault = evaluateReviewRules([source({ kind: "vault" })], rules);
  assertEquals(onVault.warnings.length, 1);
});

Deno.test("schema-strictness: flags empty-object passthrough as a warning, not an error", () => {
  const result = evaluateReviewRules([
    source({ content: "schema: z.object({}).passthrough()," }),
  ]);
  assertEquals(result.errors, []);
  assertEquals(result.warnings.length, 1);
  assertEquals(result.warnings[0].ruleId, "schema-strictness");
  assertEquals(result.passed, true);
});

Deno.test("schema-strictness: does not flag passthrough with declared properties", () => {
  const result = evaluateReviewRules([
    source({
      content: "schema: z.object({ VpcId: z.string() }).passthrough(),",
    }),
  ]);
  assertEquals(result.warnings.length, 0);
});

Deno.test("schema-strictness: ignores commented-out passthrough", () => {
  const result = evaluateReviewRules([
    source({ content: "// schema: z.object({}).passthrough()," }),
  ]);
  assertEquals(result.warnings.length, 0);
});

Deno.test("credentials-sensitive-field: warns on unmarked secret field", () => {
  const result = evaluateReviewRules([
    source({
      kind: "vault",
      content: "  apiToken: z.string(),",
    }),
  ]);
  assertEquals(result.warnings.length, 1);
  assertEquals(result.warnings[0].ruleId, "credentials-sensitive-field");
});

Deno.test("credentials-sensitive-field: no warning when marked sensitive", () => {
  const result = evaluateReviewRules([
    source({
      kind: "vault",
      content: "  apiToken: z.string().meta({ sensitive: true }),",
    }),
  ]);
  assertEquals(result.warnings.length, 0);
});

Deno.test("testing-completeness: warns when entry point lacks a sibling test", () => {
  const result = evaluateReviewRules([
    source({ isEntryPoint: true, hasSiblingTest: false, content: "" }),
  ]);
  const ids = result.warnings.map((w) => w.ruleId);
  assert(ids.includes("testing-completeness"));
});

Deno.test("testing-completeness: no warning for non-entry-point files", () => {
  const result = evaluateReviewRules([
    source({ isEntryPoint: false, hasSiblingTest: false, content: "" }),
  ]);
  assertEquals(
    result.warnings.filter((w) => w.ruleId === "testing-completeness").length,
    0,
  );
});

Deno.test("driver-log-forwarding: warns when a driver never forwards logs", () => {
  const result = evaluateReviewRules([
    source({ kind: "driver", content: "export const driver = {};" }),
  ]);
  const ids = result.warnings.map((w) => w.ruleId);
  assert(ids.includes("driver-log-forwarding"));
});

Deno.test("driver-log-forwarding: no warning when onLog is used", () => {
  const result = evaluateReviewRules([
    source({ kind: "driver", content: "callbacks?.onLog?.(line);" }),
  ]);
  assertEquals(
    result.warnings.filter((w) => w.ruleId === "driver-log-forwarding").length,
    0,
  );
});

Deno.test("checkReviewRules: reads content, computes sibling test, skips test files", async () => {
  const fileContents: Record<string, string> = {
    "/ext/models/thing.ts": "schema: z.object({}).passthrough(),",
    "/ext/models/thing_test.ts": "Deno.test(...)",
  };
  const io: ReviewRulesIo = {
    readTextFile: (path) => Promise.resolve(fileContents[path] ?? ""),
    fileExists: (path) => Promise.resolve(path in fileContents),
  };
  const result = await checkReviewRules(
    {
      files: [
        { path: "/ext/models/thing.ts", kind: "model", isEntryPoint: true },
        {
          path: "/ext/models/thing_test.ts",
          kind: "model",
          isEntryPoint: false,
        },
      ],
    },
    DEFAULT_REVIEW_RULES,
    io,
  );
  // schema-strictness warns; testing-completeness does NOT (sibling test exists).
  const ids = result.warnings.map((w) => w.ruleId);
  assert(ids.includes("schema-strictness"));
  assertEquals(ids.includes("testing-completeness"), false);
});

Deno.test("checkReviewRules: skips non-ts files and unreadable files", async () => {
  const io: ReviewRulesIo = {
    readTextFile: (path) => {
      if (path.endsWith("missing.ts")) return Promise.reject(new Error("nope"));
      return Promise.resolve("");
    },
    fileExists: () => Promise.resolve(false),
  };
  const result = await checkReviewRules(
    {
      files: [
        {
          path: "/ext/reports/report.yaml",
          kind: "report",
          isEntryPoint: true,
        },
        { path: "/ext/models/missing.ts", kind: "model", isEntryPoint: true },
      ],
    },
    DEFAULT_REVIEW_RULES,
    io,
  );
  // yaml skipped; unreadable ts skipped — no crash, no findings from them.
  assertEquals(result.errors, []);
});

Deno.test("checkReviewRules: entry point without sibling test warns", async () => {
  const io: ReviewRulesIo = {
    readTextFile: () => Promise.resolve("export const x = 1;"),
    fileExists: () => Promise.resolve(false),
  };
  const result = await checkReviewRules(
    {
      files: [{ path: "/ext/vaults/v.ts", kind: "vault", isEntryPoint: true }],
    },
    DEFAULT_REVIEW_RULES,
    io,
  );
  const ids = result.warnings.map((w) => w.ruleId);
  assert(ids.includes("testing-completeness"));
});

// ── Report machinery ──────────────────────────────────────────────────

Deno.test("applicableDimensions: universal always present; type-specific gated by kind", () => {
  const modelOnly = applicableDimensions(["model"]).map((d) => d.id);
  assert(modelOnly.includes("credentials-secrets")); // universal
  assert(modelOnly.includes("schema-strictness")); // model-specific
  assertEquals(modelOnly.includes("vault-getname"), false); // vault-specific
  const vaultOnly = applicableDimensions(["vault"]).map((d) => d.id);
  assert(vaultOnly.includes("vault-getname"));
  assertEquals(vaultOnly.includes("schema-strictness"), false);
});

Deno.test("reviewReportPath: deterministic and hash-bound", () => {
  const a = reviewReportPath("@acme/thing", "abcdef0123456789aa", "/tmp");
  const b = reviewReportPath("@acme/thing", "abcdef0123456789aa", "/tmp");
  assertEquals(a, b);
  const c = reviewReportPath("@acme/thing", "ffffffffffffffffbb", "/tmp");
  assert(a !== c); // different hash → different path
});

Deno.test("parseReviewReport: returns null on malformed JSON or bad shape", () => {
  assertEquals(parseReviewReport("not json"), null);
  assertEquals(parseReviewReport('{"extension":"x"}'), null);
  const ok = parseReviewReport(
    JSON.stringify({
      extension: "@a/b",
      version: "1",
      reviewedAt: "now",
      dimensions: [{ id: "credentials-secrets", verdict: "pass" }],
    }),
  );
  assert(ok !== null);
});

function reportCtx(
  report: ExtensionReviewReport | null,
  dims: ReviewDimension[],
) {
  return {
    report,
    reportPath: "/tmp/review.json",
    extensionName: "@a/b",
    extensionVersion: "1",
    applicableDimensions: dims,
    skeleton: "{}",
  };
}

Deno.test("evaluateReviewReport: missing report is a warning (prompt), never a hard block", () => {
  const findings = evaluateReviewReport(
    reportCtx(null, applicableDimensions(["model"])),
  );
  assertEquals(findings.length, 1);
  assertEquals(findings[0].severity, "medium");
  // The report path must be carried on the finding (rendered in log mode).
  assertEquals(findings[0].file, "/tmp/review.json");
  // The message is a single, self-sufficient line (no embedded skeleton).
  assertEquals(findings[0].message.includes("\n"), false);
  assert(!findings[0].message.includes("{"));
  // The skeleton rides on its own field for JSON consumers.
  assertEquals(findings[0].skeleton, "{}");
});

Deno.test("evaluateReviewReport: name/version mismatch warns (e.g. manual version bump)", () => {
  const report: ExtensionReviewReport = {
    extension: "@a/b",
    version: "9", // report from a different version
    reviewedAt: "now",
    dimensions: [],
  };
  const findings = evaluateReviewReport(reportCtx(report, []));
  assert(findings.length > 0);
  assertEquals(findings.every((f) => f.severity === "medium"), true);
});

Deno.test("evaluateReviewReport: pending verdicts warn, issue warns, all-pass is clean", () => {
  const dims = applicableDimensions(["vault"]);
  // One pending, the rest pass.
  const pendingReport: ExtensionReviewReport = {
    extension: "@a/b",
    version: "1",
    reviewedAt: "now",
    dimensions: dims.map((d, i) => ({
      id: d.id,
      verdict: i === 0 ? ("pending" as const) : ("pass" as const),
    })),
  };
  const pendingFindings = evaluateReviewReport(reportCtx(pendingReport, dims));
  assert(pendingFindings.length > 0);
  assertEquals(pendingFindings.every((f) => f.severity === "medium"), true);

  // All pass except one issue → exactly one warning.
  const passReport: ExtensionReviewReport = {
    extension: "@a/b",
    version: "1",
    reviewedAt: "now",
    dimensions: dims.map((d, i) => ({
      id: d.id,
      verdict: i === 0 ? ("issue" as const) : ("pass" as const),
      note: i === 0 ? "needs work" : undefined,
    })),
  };
  const passFindings = evaluateReviewReport(reportCtx(passReport, dims));
  assertEquals(passFindings.length, 1);
  assertEquals(passFindings[0].severity, "medium");

  // Fully clean report → no findings.
  const cleanReport: ExtensionReviewReport = {
    extension: "@a/b",
    version: "1",
    reviewedAt: "now",
    dimensions: dims.map((d) => ({ id: d.id, verdict: "pass" as const })),
  };
  assertEquals(evaluateReviewReport(reportCtx(cleanReport, dims)).length, 0);
});

Deno.test("checkReviewRules: validates report when a report request is supplied", async () => {
  const dims = applicableDimensions(["model"]);
  const skeleton = buildReviewReportSkeleton("@a/b", "1", dims);
  const io: ReviewRulesIo = {
    readTextFile: () => Promise.reject(new Error("missing")),
    fileExists: () => Promise.resolve(true),
  };
  const result = await checkReviewRules(
    {
      files: [],
      report: {
        reportPath: "/tmp/review.json",
        extensionName: "@a/b",
        extensionVersion: "1",
        applicableDimensions: dims,
        skeleton,
      },
    },
    DEFAULT_REVIEW_RULES,
    io,
  );
  // Missing report → non-blocking warning (prompt), not a hard error.
  assertEquals(result.passed, true);
  assert(result.warnings.some((w) => w.ruleId === "adversarial-review-report"));
});

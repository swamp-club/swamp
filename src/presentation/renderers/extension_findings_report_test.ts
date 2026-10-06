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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import type { ReviewFinding } from "../../domain/extensions/extension_review_rules.ts";
import {
  buildFindingsReport,
  withAcceptance,
} from "./extension_findings_report.ts";

const DIR = resolve("/ext");

const secret: ReviewFinding = {
  ruleId: "credentials-sensitive-field",
  dimension: "Credentials & Secrets",
  severity: "medium",
  file: join(DIR, "models", "a.ts"),
  line: 4,
  message: "looks like a secret\nsecond line",
  remediation: "mark it sensitive",
};

const review: ReviewFinding = {
  ruleId: "adversarial-review-report",
  dimension: "Adversarial review",
  severity: "medium",
  file: "/tmp/review.json",
  message: "No adversarial review recorded",
  remediation: "run the review",
  skeleton: "{}",
};

Deno.test("buildFindingsReport: an unaccepted finding becomes advice with a relative path, the first message line, remediation and the paste text", () => {
  const report = buildFindingsReport({
    safetyWarnings: [{
      ruleId: "deno-command",
      file: join(DIR, "models", "b.ts"),
      line: 9,
      message: "Line 9 uses Deno.Command() to spawn subprocesses.",
      remediation: "prefer primitives",
    }],
    reviewWarnings: [secret, review],
    acceptances: { accepted: [] },
  }, DIR);
  assertEquals("declaredAcceptances" in report, false);
  assertEquals(report.forNextTime?.length, 3);
  const [cmd, field, adversarial] = report.forNextTime!;
  assertEquals(cmd.file, "models/b.ts");
  assertEquals(cmd.line, 9);
  assertEquals(
    cmd.acceptance,
    "// swamp-quality-ignore deno-command: <reason>",
  );
  assertStringIncludes(cmd.placement ?? "", "line 9 of models/b.ts");
  assertEquals(field.message, "looks like a secret");
  assertEquals(field.remediation, "mark it sensitive");
  assertEquals(adversarial.acceptance, undefined);
  assertEquals(adversarial.placement, undefined);
  assertEquals(adversarial.remediation, "run the review");
});

Deno.test("buildFindingsReport: a collapsed testing-completeness finding expands to one entry per remaining file", () => {
  const report = buildFindingsReport({
    safetyWarnings: [],
    reviewWarnings: [{
      ruleId: "testing-completeness",
      dimension: "Testing Completeness",
      severity: "medium",
      file: "(2 files)",
      message: "2 of 3 entry points have no sibling test",
      files: [join(DIR, "models", "b.ts"), join(DIR, "models", "c.ts")],
    }],
    acceptances: { accepted: [] },
  }, DIR);
  assertEquals(report.forNextTime?.map((e) => e.file), [
    "models/b.ts",
    "models/c.ts",
  ]);
  assertStringIncludes(report.forNextTime?.[0].message ?? "", "No sibling");
  assertEquals(
    report.forNextTime?.[0].acceptance,
    "// swamp-quality-ignore testing-completeness: <reason>",
  );
  assertStringIncludes(
    report.forNextTime?.[1].placement ?? "",
    "top of models/c.ts",
  );
});

Deno.test("buildFindingsReport: declared acceptances are carried as given, and both blocks are omitted when empty", () => {
  const acceptances = {
    accepted: [{
      ruleId: "bare-specifiers",
      reason: "scored locally",
      source: "sidecar" as const,
      message: "bare imports",
    }],
  };
  const report = buildFindingsReport(
    { safetyWarnings: [], reviewWarnings: [], acceptances },
    DIR,
  );
  assertEquals(report, { declaredAcceptances: acceptances });
  const generatedOnly = buildFindingsReport({
    safetyWarnings: [],
    reviewWarnings: [],
    acceptances: {
      accepted: [],
      generated: { by: "codegen", source: "spec", commit: "abc" },
    },
  }, DIR);
  assertEquals(generatedOnly.declaredAcceptances?.generated?.by, "codegen");
  assertEquals(
    buildFindingsReport(
      { safetyWarnings: [], reviewWarnings: [], acceptances: { accepted: [] } },
      DIR,
    ),
    {},
  );
});

Deno.test("withAcceptance: attaches the paste text to acceptable findings only, leaving the rest untouched", () => {
  const [field, adversarial] = withAcceptance([secret, review], DIR);
  assertEquals(
    field.acceptance,
    "// swamp-quality-ignore credentials-sensitive-field: <reason>",
  );
  assertEquals(field.remediation, "mark it sensitive");
  assertEquals("acceptance" in adversarial, false);
  assertEquals(adversarial.skeleton, "{}");
});

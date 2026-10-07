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
import { join, relative, resolve } from "@std/path";
import type { CommentSites } from "../../domain/extensions/extension_acceptances.ts";
import type { ReviewFinding } from "../../domain/extensions/extension_review_rules.ts";
import type { Logger } from "@logtape/logtape";
import {
  buildFindingsReport,
  NO_ACCEPTANCE_HERE,
  renderFindingsReport,
  withAcceptance,
} from "./extension_findings_report.ts";

const DIR = resolve("/ext");

/** Lines 1 to 20 of every source file the tests name take a comment, unindented. */
const OPEN: Record<string, CommentSites> = Object.fromEntries(
  ["a.ts", "b.ts", "c.ts"].map((name) => [
    join(DIR, "models", name),
    Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [i + 1, ""]),
    ) as CommentSites,
  ]),
);

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
  skeleton: {
    extension: "@a/b",
    version: "1",
    reviewedAt: "<ISO-8601 timestamp>",
    dimensions: [],
  },
};

Deno.test("buildFindingsReport: an unaccepted finding becomes an unresolved warning with its absolute path, the first message line, remediation and the acceptance", () => {
  const modelB = join(DIR, "models", "b.ts");
  const report = buildFindingsReport({
    safetyWarnings: [{
      ruleId: "deno-command",
      file: modelB,
      line: 9,
      message: "Line 9 uses Deno.Command() to spawn subprocesses.",
      remediation: "prefer primitives",
    }],
    reviewWarnings: [secret, review],
    acceptances: { accepted: [] },
    commentSites: OPEN,
  }, DIR);
  assertEquals("declaredAcceptances" in report, false);
  assertEquals(report.unresolvedWarnings?.length, 3);
  const [cmd, field, adversarial] = report.unresolvedWarnings!;
  assertEquals(cmd, {
    ruleId: "deno-command",
    file: modelB,
    line: 9,
    message: "Line 9 uses Deno.Command() to spawn subprocesses.",
    remediation: "prefer primitives",
    acceptance: {
      form: "comment",
      file: modelB,
      line: 9,
      position: "line-above",
      text: "// swamp-quality-ignore deno-command",
    },
  });
  assertEquals(field.message, "looks like a secret");
  assertEquals(field.remediation, "mark it sensitive");
  assertEquals("acceptance" in adversarial, false);
  assertEquals(adversarial.remediation, "run the review");
});

Deno.test("buildFindingsReport: two sidecar findings give two entries for one accept list", () => {
  const report = buildFindingsReport({
    safetyWarnings: ["hosts", "lab"].map((name) => ({
      ruleId: "ipv4-address-literals",
      file: join(DIR, "docs", `${name}.txt`),
      line: 1,
      message: "IPv4 literal",
    })),
    reviewWarnings: [],
    acceptances: { accepted: [] },
    commentSites: OPEN,
  }, DIR);
  assertEquals(
    report.unresolvedWarnings?.map((w) => w.acceptance),
    ["hosts", "lab"].map((name) => ({
      form: "sidecar" as const,
      file: join(DIR, "quality.yaml"),
      entry: { rule: "ipv4-address-literals", file: `docs/${name}.txt` },
    })),
  );
});

Deno.test("buildFindingsReport: a collapsed testing-completeness finding expands to one entry per remaining file, each with a header acceptance", () => {
  const files = [join(DIR, "models", "b.ts"), join(DIR, "models", "c.ts")];
  const report = buildFindingsReport({
    safetyWarnings: [],
    reviewWarnings: [{
      ruleId: "testing-completeness",
      dimension: "Testing Completeness",
      severity: "medium",
      file: "(2 files)",
      message: "2 of 3 entry points have no sibling test",
      files,
    }],
    acceptances: { accepted: [] },
    commentSites: OPEN,
  }, DIR);
  assertEquals(report.unresolvedWarnings?.map((e) => e.file), files);
  assertStringIncludes(
    report.unresolvedWarnings?.[0].message ?? "",
    "No sibling",
  );
  assertEquals(
    report.unresolvedWarnings?.map((e) => e.acceptance),
    files.map((file) => ({
      form: "comment" as const,
      file,
      line: 1,
      position: "file-header" as const,
      text: "// swamp-quality-ignore testing-completeness",
    })),
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
    {
      safetyWarnings: [],
      reviewWarnings: [],
      acceptances,
      commentSites: {},
    },
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
    commentSites: {},
  }, DIR);
  assertEquals(generatedOnly.declaredAcceptances?.generated?.by, "codegen");
  assertEquals(
    buildFindingsReport(
      {
        safetyWarnings: [],
        reviewWarnings: [],
        acceptances: { accepted: [] },
        commentSites: {},
      },
      DIR,
    ),
    {},
  );
});

Deno.test("buildFindingsReport: a finding on a line no comment can go above keeps its fix but offers no acceptance", () => {
  const modelB = join(DIR, "models", "b.ts");
  const report = buildFindingsReport({
    safetyWarnings: [{
      ruleId: "base64-run",
      file: modelB,
      line: 5,
      message: "Line 5 has a base64 run",
      remediation: "load it from a file",
    }],
    reviewWarnings: [],
    acceptances: { accepted: [] },
    commentSites: { [modelB]: { 4: "", 6: "" } },
  }, DIR);
  assertEquals(
    report.unresolvedWarnings?.[0].remediation,
    "load it from a file",
  );
  assertEquals("acceptance" in report.unresolvedWarnings![0], false);
});

Deno.test("renderFindingsReport: an acceptable rule with no acceptance on its line says why, an unacceptable one says nothing", () => {
  const lines: string[] = [];
  const logger = {
    info: (message: string) =>
      lines.push(message.replaceAll("{{", "{").replaceAll("}}", "}")),
  } as unknown as Logger;
  renderFindingsReport(logger, {
    unresolvedWarnings: [
      { ruleId: "base64-run", file: join(DIR, "a.ts"), line: 5, message: "m" },
      {
        ruleId: "adversarial-review-report",
        file: "/tmp/r.json",
        message: "n",
      },
    ],
  }, {
    manifestDir: DIR,
    display: (path) => path === join(DIR, "a.ts") ? "a.ts" : path,
  });
  assertEquals(lines, [
    "Unresolved warnings:",
    "  base64-run — a.ts:5: m",
    `    ${NO_ACCEPTANCE_HERE}`,
    "  adversarial-review-report — /tmp/r.json: n",
  ]);
});

Deno.test("withAcceptance: attaches the acceptance to acceptable findings only, leaving the rest untouched", () => {
  const collapsed: ReviewFinding = {
    ruleId: "testing-completeness",
    dimension: "Testing Completeness",
    severity: "medium",
    file: "(2 files)",
    message: "2 of 3 entry points have no sibling test",
    files: [join(DIR, "models", "b.ts"), join(DIR, "models", "c.ts")],
  };
  const [field, adversarial, many] = withAcceptance(
    [secret, review, collapsed],
    DIR,
    OPEN,
  );
  assertEquals(field.acceptance, {
    form: "comment",
    file: secret.file,
    line: 4,
    position: "line-above",
    text: "// swamp-quality-ignore credentials-sensitive-field",
  });
  assertEquals(field.remediation, "mark it sensitive");
  assertEquals("acceptance" in adversarial, false);
  assertEquals(adversarial.skeleton, review.skeleton);
  // A collapsed finding stands for several files; each takes its own
  // acceptance in the unresolved warnings.
  assertEquals("acceptance" in many, false);
});

Deno.test("renderFindingsReport: one line per option, quoting a sidecar file name that needs it, and no reason when none was given", () => {
  const lines: string[] = [];
  const logger = {
    // LogTape reads a plain string as a template, with braces doubled.
    info: (message: string) =>
      lines.push(message.replaceAll("{{", "{").replaceAll("}}", "}")),
  } as unknown as Logger;
  renderFindingsReport(logger, {
    declaredAcceptances: {
      accepted: [{
        ruleId: "deno-command",
        file: "models/a.ts",
        line: 3,
        source: "inline",
        message: "uses Deno.Command",
      }],
    },
    unresolvedWarnings: [{
      ruleId: "ipv4-address-literals",
      file: join(DIR, "docs", "a: b.txt"),
      line: 1,
      message: "IPv4 literal",
      acceptance: {
        form: "sidecar",
        file: join(DIR, "quality.yaml"),
        entry: { rule: "ipv4-address-literals", file: "docs/a: b.txt" },
      },
    }, {
      ruleId: "ipv4-address-literals",
      file: join(DIR, "README.md"),
      line: 7,
      message: "IPv4 literal",
      acceptance: {
        form: "comment",
        file: join(DIR, "README.md"),
        line: 7,
        position: "line-above",
        text: "<!-- swamp-quality-ignore ipv4-address-literals -->",
      },
    }, {
      ruleId: "testing-completeness",
      file: join(DIR, "models", "b.ts"),
      message: "No sibling test",
      acceptance: {
        form: "comment",
        file: join(DIR, "models", "b.ts"),
        line: 1,
        position: "file-header",
        text: "// swamp-quality-ignore testing-completeness",
      },
    }],
  }, {
    manifestDir: DIR,
    display: (path) => relative(DIR, path).replaceAll("\\", "/"),
  });
  assertEquals(lines, [
    "Accepted warnings:",
    "  deno-command — models/a.ts:3",
    "Unresolved warnings:",
    "  ipv4-address-literals — docs/a: b.txt:1: IPv4 literal",
    "    or accept in quality.yaml: { rule: ipv4-address-literals, file: 'docs/a: b.txt' }",
    "  ipv4-address-literals — README.md:7: IPv4 literal",
    "    or accept on the line above: <!-- swamp-quality-ignore ipv4-address-literals -->",
    "  testing-completeness — models/b.ts: No sibling test",
    "    or accept at the top of the file: // swamp-quality-ignore testing-completeness",
  ]);
});

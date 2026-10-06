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
import {
  type AcceptanceDirective,
  applyAcceptances,
  commentFormFor,
  invalidAcceptanceFinding,
  MAX_ACCEPTANCE_REASON_LENGTH,
  MAX_DIRECTIVES_PER_FILE,
  parseAcceptanceDirectives,
  staleAcceptanceFinding,
  validateAcceptance,
} from "./extension_acceptances.ts";

const TS = "/ext/models/thing.ts";
const MD = "/ext/README.md";

Deno.test("commentFormFor: ts and md have a comment form, txt and yaml do not", () => {
  assertEquals(commentFormFor("/a/b.ts"), "line");
  assertEquals(commentFormFor("/a/B.MD"), "html");
  assertEquals(commentFormFor("/a/hosts.txt"), "none");
  assertEquals(commentFormFor("/a/quality.yaml"), "none");
});

Deno.test("parseAcceptanceDirectives: a trailing comment accepts its own line", () => {
  const content = [
    "const S = z.object({",
    "  secretName: z.string(), // swamp-quality-ignore credentials-sensitive-field: reference to a Secret, not a secret",
    "});",
  ].join("\n");
  const parsed = parseAcceptanceDirectives(content, TS);
  assertEquals(parsed.invalid, []);
  assertEquals(parsed.directives, [{
    ruleId: "credentials-sensitive-field",
    reason: "reference to a Secret, not a secret",
    target: { kind: "line", file: TS, line: 2 },
    source: "inline",
    declaredAt: { file: TS, line: 2 },
  }]);
});

Deno.test("parseAcceptanceDirectives: a standalone comment accepts the line below", () => {
  const content = [
    "const S = z.object({",
    "  // swamp-quality-ignore credentials-sensitive-field: holds a vault key name",
    "  apiKey: z.string(),",
    "});",
  ].join("\n");
  const parsed = parseAcceptanceDirectives(content, TS);
  assertEquals(parsed.invalid, []);
  assertEquals(parsed.directives[0].target, {
    kind: "line",
    file: TS,
    line: 3,
  });
  assertEquals(parsed.directives[0].declaredAt, { file: TS, line: 2 });
});

Deno.test("parseAcceptanceDirectives: a file-scoped rule is accepted for the whole file wherever the comment sits", () => {
  const content = [
    "// swamp-quality-ignore testing-completeness: thin wrapper, covered by the integration suite",
    "export const model = {};",
  ].join("\n");
  const parsed = parseAcceptanceDirectives(content, TS);
  assertEquals(parsed.invalid, []);
  assertEquals(parsed.directives[0].target, { kind: "file", file: TS });
});

Deno.test("parseAcceptanceDirectives: a Markdown HTML comment on the line above accepts the next line", () => {
  const content = [
    "# Hosts",
    "<!-- swamp-quality-ignore ipv4-address-literals: documented lab address -->",
    "Gateway: 10.0.0.1",
  ].join("\n");
  const parsed = parseAcceptanceDirectives(content, MD);
  assertEquals(parsed.invalid, []);
  assertEquals(parsed.directives[0].target, {
    kind: "line",
    file: MD,
    line: 3,
  });
  assertEquals(parsed.directives[0].reason, "documented lab address");
});

Deno.test("parseAcceptanceDirectives: an unclosed Markdown comment is invalid", () => {
  const parsed = parseAcceptanceDirectives(
    "<!-- swamp-quality-ignore ipv4-address-literals: lab\n10.0.0.1\n",
    MD,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(parsed.invalid[0].problem, "not closed");
});

Deno.test("parseAcceptanceDirectives: a comment with no reason is invalid", () => {
  const parsed = parseAcceptanceDirectives(
    "new Deno.Command('ls'); // swamp-quality-ignore deno-command:\n",
    TS,
  );
  assertEquals(parsed.directives, []);
  assertEquals(parsed.invalid.length, 1);
  assertStringIncludes(parsed.invalid[0].problem, "reason is required");
  assertEquals(parsed.invalid[0].line, 1);
  assertStringIncludes(
    parsed.invalid[0].text,
    "swamp-quality-ignore deno-command:",
  );
});

Deno.test("parseAcceptanceDirectives: an error-level rule cannot be accepted", () => {
  const parsed = parseAcceptanceDirectives(
    "eval(x); // swamp-quality-ignore dynamic-code: trust me\n",
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(
    parsed.invalid[0].problem,
    "error-level rule and cannot be accepted",
  );
});

Deno.test("parseAcceptanceDirectives: an unknown rule id is invalid, not stale", () => {
  const parsed = parseAcceptanceDirectives(
    "x; // swamp-quality-ignore deno-comand: typo\n",
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(parsed.invalid[0].problem, "is not a rule id");
});

Deno.test("parseAcceptanceDirectives: the adversarial-review family and the meta rules are not acceptable", () => {
  for (
    const id of [
      "adversarial-review-report",
      "stale-acceptance",
      "invalid-acceptance",
    ]
  ) {
    const parsed = parseAcceptanceDirectives(
      `x; // swamp-quality-ignore ${id}: no\n`,
      TS,
    );
    assertEquals(parsed.directives, [], id);
    assertEquals(parsed.invalid.length, 1, id);
  }
});

Deno.test("parseAcceptanceDirectives: an extension-scoped rule in a comment points at the sidecar", () => {
  const parsed = parseAcceptanceDirectives(
    "import x from 'lodash'; // swamp-quality-ignore bare-specifiers: fine\n",
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(parsed.invalid[0].problem, "quality.yaml");
});

Deno.test("parseAcceptanceDirectives: a malformed directive is invalid", () => {
  const parsed = parseAcceptanceDirectives(
    "x; // swamp-quality-ignore\n",
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(parsed.invalid[0].problem, "<rule-id>: <reason>");
});

Deno.test("parseAcceptanceDirectives: the keyword outside a comment is not a directive", () => {
  const parsed = parseAcceptanceDirectives(
    'const doc = "write swamp-quality-ignore deno-command: here";\n',
    TS,
  );
  assertEquals(parsed.directives, []);
  assertEquals(parsed.invalid, []);
});

Deno.test("parseAcceptanceDirectives: a reason over the cap is rejected, not truncated", () => {
  const reason = "r".repeat(MAX_ACCEPTANCE_REASON_LENGTH + 1);
  const parsed = parseAcceptanceDirectives(
    `x; // swamp-quality-ignore deno-command: ${reason}\n`,
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(parsed.invalid[0].problem, "longer than");
});

Deno.test("parseAcceptanceDirectives: more directives than the per-file cap are rejected", () => {
  const lines: string[] = [];
  for (let i = 0; i <= MAX_DIRECTIVES_PER_FILE; i++) {
    lines.push(`x; // swamp-quality-ignore deno-command: reason ${i}`);
  }
  const parsed = parseAcceptanceDirectives(lines.join("\n"), TS);
  assertEquals(parsed.directives.length, MAX_DIRECTIVES_PER_FILE);
  assertEquals(parsed.invalid.length, 1);
  assertStringIncludes(parsed.invalid[0].problem, "more than");
});

Deno.test("parseAcceptanceDirectives: files with no comment form yield nothing", () => {
  const parsed = parseAcceptanceDirectives(
    "swamp-quality-ignore ipv4-address-literals: x\n10.0.0.1\n",
    "/ext/hosts.txt",
  );
  assertEquals(parsed, { directives: [], invalid: [] });
});

Deno.test("validateAcceptance: a site-scoped rule in the sidecar is refused", () => {
  assertStringIncludes(
    validateAcceptance("credentials-sensitive-field", "x", "sidecar")!,
    "site-scoped",
  );
  assertEquals(
    validateAcceptance("bare-specifiers", "x", "sidecar"),
    undefined,
  );
  assertEquals(
    validateAcceptance("testing-completeness", "x", "sidecar"),
    undefined,
  );
});

const directive = (
  overrides: Partial<AcceptanceDirective>,
): AcceptanceDirective => ({
  ruleId: "deno-command",
  reason: "r",
  target: { kind: "line", file: TS, line: 2 },
  source: "inline",
  declaredAt: { file: TS, line: 2 },
  ...overrides,
});

Deno.test("applyAcceptances: a line directive accepts exactly that finding and leaves the rest", () => {
  const findings = [
    { ruleId: "deno-command", file: TS, line: 2 },
    { ruleId: "deno-command", file: TS, line: 9 },
    { ruleId: "deno-command", file: "/ext/models/other.ts", line: 2 },
  ];
  const result = applyAcceptances(findings, [directive({})]);
  assertEquals(result.accepted.map((a) => a.finding), [findings[0]]);
  assertEquals(result.accepted[0].reason, "r");
  assertEquals(result.remaining, [findings[1], findings[2]]);
  assertEquals(result.stale, []);
});

Deno.test("applyAcceptances: a file directive accepts every finding of the rule in that file only", () => {
  const findings = [
    { ruleId: "ipv4-address-literals", file: "/ext/hosts.txt", line: 1 },
    { ruleId: "ipv4-address-literals", file: "/ext/hosts.txt", line: 4 },
    { ruleId: "ipv4-address-literals", file: "/ext/other.txt", line: 1 },
    { ruleId: "deno-command", file: "/ext/hosts.txt", line: 1 },
  ];
  const d = directive({
    ruleId: "ipv4-address-literals",
    target: { kind: "file", file: "/ext/hosts.txt" },
    source: "sidecar",
    declaredAt: { file: "/ext/quality.yaml", line: 1 },
  });
  const result = applyAcceptances(findings, [d]);
  assertEquals(result.accepted.length, 2);
  assertEquals(result.remaining, [findings[2], findings[3]]);
});

Deno.test("applyAcceptances: an extension directive accepts every finding of the rule", () => {
  const findings = [
    { ruleId: "bare-specifiers", file: "(multiple files)" },
    { ruleId: "deno-command", file: TS, line: 1 },
  ];
  const d = directive({
    ruleId: "bare-specifiers",
    target: { kind: "extension" },
    source: "sidecar",
    declaredAt: { file: "/ext/quality.yaml", line: 1 },
  });
  const result = applyAcceptances(findings, [d]);
  assertEquals(result.accepted.map((a) => a.finding), [findings[0]]);
  assertEquals(result.remaining, [findings[1]]);
});

Deno.test("applyAcceptances: a directive that matches nothing is stale, a generated declaration is not", () => {
  const stale = directive({ target: { kind: "line", file: TS, line: 7 } });
  const generated = directive({
    ruleId: "testing-completeness",
    target: { kind: "extension" },
    source: "generated",
    declaredAt: { file: "/ext/quality.yaml", line: 1 },
  });
  const result = applyAcceptances(
    [{ ruleId: "deno-command", file: TS, line: 2 }],
    [stale, generated],
  );
  assertEquals(result.stale, [stale]);
  assertEquals(result.remaining.length, 1);
});

Deno.test("applyAcceptances: a line directive never widens to another line, file or rule", () => {
  const findings = [
    { ruleId: "deno-command", file: TS, line: 3 },
    { ruleId: "base64-run", file: TS, line: 2 },
    { ruleId: "deno-command", file: "/ext/models/b.ts", line: 2 },
  ];
  const result = applyAcceptances(findings, [directive({})]);
  assertEquals(result.accepted, []);
  assertEquals(result.remaining, findings);
  assertEquals(result.stale.length, 1);
});

Deno.test("invalidAcceptanceFinding: blocks, names the comment, file and line", () => {
  const finding = invalidAcceptanceFinding({
    file: TS,
    line: 4,
    text: "// swamp-quality-ignore dynamic-code: trust me",
    problem: '"dynamic-code" is an error-level rule and cannot be accepted',
  });
  assertEquals(finding.ruleId, "invalid-acceptance");
  assertEquals(finding.severity, "high");
  assertEquals(finding.file, TS);
  assertEquals(finding.line, 4);
  assertStringIncludes(
    finding.message,
    "swamp-quality-ignore dynamic-code: trust me",
  );
  assertStringIncludes(finding.message, "cannot be accepted");
});

Deno.test("staleAcceptanceFinding: warns at the directive's own location", () => {
  const finding = staleAcceptanceFinding(
    directive({
      target: { kind: "line", file: TS, line: 8 },
      declaredAt: { file: TS, line: 7 },
    }),
  );
  assertEquals(finding.ruleId, "stale-acceptance");
  assertEquals(finding.severity, "medium");
  assertEquals(finding.line, 7);
  assertStringIncludes(finding.message, "line 8");
  assertEquals(typeof finding.remediation, "string");
});

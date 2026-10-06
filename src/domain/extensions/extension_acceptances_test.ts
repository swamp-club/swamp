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
  acceptanceSnippet,
  applyAcceptances,
  commentFormFor,
  fileRelativeToManifest,
  invalidAcceptanceFinding,
  MAX_ACCEPTANCE_REASON_LENGTH,
  MAX_DIRECTIVES_PER_FILE,
  parseAcceptanceDirectives,
  REASON_PLACEHOLDER,
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

Deno.test("parseAcceptanceDirectives: a standalone directive skips blank lines to its target, in both forms", () => {
  const md = parseAcceptanceDirectives(
    "<!-- swamp-quality-ignore ipv4-address-literals: lab -->\n\nGateway: 10.0.0.1\n",
    MD,
  );
  assertEquals(md.directives[0].target, { kind: "line", file: MD, line: 3 });
  const ts = parseAcceptanceDirectives(
    "// swamp-quality-ignore deno-command: vendor CLI\n\n\nnew Deno.Command('x');\n",
    TS,
  );
  assertEquals(ts.directives[0].target, { kind: "line", file: TS, line: 4 });
});

Deno.test("parseAcceptanceDirectives: a comment opener inside a string literal is not a directive", () => {
  const parsed = parseAcceptanceDirectives(
    'const HEADER = "// swamp-quality-ignore testing-completeness: <reason>";\n' +
      "const T = `// swamp-quality-ignore deno-command: x`;\n" +
      "const U = '// swamp-quality-ignore deno-command'; // swamp-quality-ignore deno-command: real\n",
    TS,
  );
  assertEquals(parsed.invalid, []);
  assertEquals(parsed.directives.length, 1);
  assertEquals(parsed.directives[0].reason, "real");
  assertEquals(parsed.directives[0].target, {
    kind: "line",
    file: TS,
    line: 3,
  });
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
  assertStringIncludes(
    validateAcceptance("testing-completeness", "x", "sidecar")!,
    "file-scoped",
  );
  assertEquals(
    validateAcceptance("ipv4-address-literals", "x", "sidecar-file"),
    undefined,
  );
  assertStringIncludes(
    validateAcceptance("bare-specifiers", "x", "sidecar-file")!,
    "takes no file",
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

Deno.test("parseAcceptanceDirectives: a snippet pasted verbatim, placeholder and all, is invalid", () => {
  const parsed = parseAcceptanceDirectives(
    `x; // swamp-quality-ignore deno-command: ${REASON_PLACEHOLDER}\n`,
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(parsed.invalid[0].problem, "replace <reason>");
});

Deno.test("acceptanceSnippet: a site finding in a .ts file is a line comment placed on its line or above", () => {
  const snippet = acceptanceSnippet(
    { ruleId: "deno-command", file: "/ext/models/thing.ts", line: 7 },
    "/ext",
  );
  assertEquals(snippet?.text, "// swamp-quality-ignore deno-command: <reason>");
  assertStringIncludes(snippet?.placement ?? "", "line 7 of models/thing.ts");
});

Deno.test("acceptanceSnippet: a site finding in Markdown is an HTML comment on the line above", () => {
  const snippet = acceptanceSnippet(
    { ruleId: "ipv4-address-literals", file: "/ext/README.md", line: 3 },
    "/ext",
  );
  assertEquals(
    snippet?.text,
    "<!-- swamp-quality-ignore ipv4-address-literals: <reason> -->",
  );
  assertStringIncludes(snippet?.placement ?? "", "above line 3 of README.md");
});

Deno.test("acceptanceSnippet: a site finding in a .txt file and an extension finding are sidecar entries", () => {
  const txt = acceptanceSnippet(
    { ruleId: "ipv4-address-literals", file: "/ext/docs/hosts.txt", line: 2 },
    "/ext",
  );
  assertStringIncludes(txt?.text ?? "", "- rule: ipv4-address-literals");
  assertStringIncludes(txt?.text ?? "", "file: docs/hosts.txt");
  assertStringIncludes(txt?.text ?? "", "reason: <reason>");
  const ext = acceptanceSnippet(
    { ruleId: "bare-specifiers", file: "(multiple files)" },
    "/ext",
  );
  assertStringIncludes(ext?.text ?? "", "- rule: bare-specifiers");
  assertEquals((ext?.text ?? "").includes("file:"), false);
});

Deno.test("acceptanceSnippet: testing-completeness is a header comment; unacceptable rules have no snippet", () => {
  const header = acceptanceSnippet(
    { ruleId: "testing-completeness", file: "/ext/models/thing.ts" },
    "/ext",
  );
  assertEquals(
    header?.text,
    "// swamp-quality-ignore testing-completeness: <reason>",
  );
  assertStringIncludes(header?.placement ?? "", "top of models/thing.ts");
  assertEquals(
    acceptanceSnippet({
      ruleId: "adversarial-review-report",
      file: "/tmp/r.json",
    }, "/ext"),
    undefined,
  );
  assertEquals(
    acceptanceSnippet(
      { ruleId: "dynamic-code", file: "/ext/a.ts", line: 1 },
      "/ext",
    ),
    undefined,
  );
});

Deno.test("acceptanceSnippet: a collapsed testing-completeness finding takes the header comment for each listed file", () => {
  const snippet = acceptanceSnippet(
    { ruleId: "testing-completeness", file: "(2 files)" },
    "/ext",
  );
  assertEquals(
    snippet?.text,
    "// swamp-quality-ignore testing-completeness: <reason>",
  );
  assertStringIncludes(snippet?.placement ?? "", "each file listed");
});

Deno.test("fileRelativeToManifest: a file outside the manifest directory keeps its absolute path", () => {
  assertEquals(
    fileRelativeToManifest("/ext", "/tmp/review/report.json"),
    "/tmp/review/report.json",
  );
  assertEquals(
    fileRelativeToManifest("/ext", "/ext/models/a.ts"),
    "models/a.ts",
  );
  assertEquals(
    fileRelativeToManifest("/ext", "(multiple files)"),
    "(multiple files)",
  );
});

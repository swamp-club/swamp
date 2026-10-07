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
import { join } from "@std/path";
import {
  type AcceptanceDirective,
  acceptanceFor,
  applyAcceptances,
  commentFormFor,
  type CommentSites,
  commentSites,
  directiveSpan,
  fileRelativeToManifest,
  invalidAcceptanceFinding,
  MAX_ACCEPTANCE_REASON_LENGTH,
  MAX_DIRECTIVES_PER_FILE,
  parseAcceptanceDirectives,
  staleAcceptanceFinding,
  validateAcceptance,
  withoutDirective,
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
    "// swamp-quality-ignore deno-command: vendor CLI\n\nnew Deno.Command('x');\n",
    TS,
  );
  assertEquals(ts.directives[0].target, { kind: "line", file: TS, line: 3 });
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

Deno.test("parseAcceptanceDirectives: stacked standalone directives all target the first line that is not a directive", () => {
  const parsed = parseAcceptanceDirectives(
    [
      "// swamp-quality-ignore long-line: vendored fixture",
      "// swamp-quality-ignore base64-run: vendored fixture",
      `const BLOB = "${"A".repeat(120)}";`,
    ].join("\n"),
    TS,
  );
  assertEquals(parsed.invalid, []);
  assertEquals(parsed.directives.map((d) => d.target), [
    { kind: "line", file: TS, line: 3 },
    { kind: "line", file: TS, line: 3 },
  ]);
});

Deno.test("parseAcceptanceDirectives: an apostrophe in Markdown prose does not hide a trailing HTML directive", () => {
  const parsed = parseAcceptanceDirectives(
    "It's at 10.0.0.1 <!-- swamp-quality-ignore ipv4-address-literals: lab gateway -->\n",
    MD,
  );
  assertEquals(parsed.directives.length, 1);
  assertEquals(parsed.directives[0].target, {
    kind: "line",
    file: MD,
    line: 1,
  });
});

Deno.test("directiveSpan and withoutDirective: cover exactly the recognised comment, never text inside a string", () => {
  const ts =
    'const c = new Deno.Command("x"); // swamp-quality-ignore deno-command: vendor';
  assertEquals(withoutDirective(ts, TS), 'const c = new Deno.Command("x"); ');
  const quoted = 'const t = "// swamp-quality-ignore"; new Deno.Command("sh");';
  assertEquals(directiveSpan(quoted, TS), undefined);
  assertEquals(withoutDirective(quoted, TS), quoted);
  const md =
    "Host 10.0.0.1 <!-- swamp-quality-ignore ipv4-address-literals: lab 10.0.0.2 --> tail";
  assertEquals(withoutDirective(md, MD), "Host 10.0.0.1  tail");
  assertEquals(
    withoutDirective("plain 10.0.0.1", "/ext/hosts.txt"),
    "plain 10.0.0.1",
  );
});

Deno.test("parseAcceptanceDirectives: a directive inside a block comment that closes on the line is invalid", () => {
  const parsed = parseAcceptanceDirectives(
    'const T = "x"; /* // swamp-quality-ignore long-line: table */ new Deno.Command("sh");\n',
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(parsed.invalid[0].problem, "must end its line");
});

Deno.test("parseAcceptanceDirectives: a reason may not carry a quote, Deno.Command( or a base64 run in source", () => {
  for (
    const [reason, problem] of [
      ['y"; new Deno.Command("sh")', "quote"],
      ["wraps Deno.Command( for the CLI", "Deno.Command("],
      ["A".repeat(100), "base64"],
    ]
  ) {
    const parsed = parseAcceptanceDirectives(
      `x; // swamp-quality-ignore deno-command: ${reason}\n`,
      TS,
    );
    assertEquals(parsed.directives, [], reason);
    assertStringIncludes(parsed.invalid[0].problem, problem);
  }
  // Markdown reasons are bounded by the comment and may quote freely.
  const md = parseAcceptanceDirectives(
    '<!-- swamp-quality-ignore ipv4-address-literals: the "lab" gateway -->\n10.0.0.1\n',
    MD,
  );
  assertEquals(md.invalid, []);
  assertEquals(md.directives.length, 1);
});

Deno.test("withoutDirective: leaves a span holding a quote in place, so a fooled opener hides nothing", () => {
  const line =
    '/"/.test(s) + "// swamp-quality-ignore long-line: y"; new Deno.Command("sh");';
  assertEquals(withoutDirective(line, TS), line);
});

Deno.test("parseAcceptanceDirectives: directive text inside a Markdown fenced block or a source block comment is documentation, not a directive", () => {
  const md = parseAcceptanceDirectives(
    [
      "# Accepting a finding",
      "```markdown",
      "<!-- swamp-quality-ignore ipv4-address-literals: <reason> -->",
      "```",
      "~~~",
      "<!-- swamp-quality-ignore ipv4-address-literals: still fenced -->",
      "~~~",
      "<!-- swamp-quality-ignore ipv4-address-literals: documented lab gateway -->",
      "Gateway: 10.0.0.1",
    ].join("\n"),
    MD,
  );
  assertEquals(md.invalid, []);
  assertEquals(md.directives.length, 1);
  assertEquals(md.directives[0].target, { kind: "line", file: MD, line: 9 });

  const ts = parseAcceptanceDirectives(
    [
      "/**",
      " * Accept a finding like this:",
      " * // swamp-quality-ignore credentials-sensitive-field: <reason>",
      " */",
      "const S = z.object({",
      "  apiKey: z.string(), // swamp-quality-ignore credentials-sensitive-field: vault key name",
      "});",
    ].join("\n"),
    TS,
  );
  assertEquals(ts.invalid, []);
  assertEquals(ts.directives.length, 1);
  assertEquals(ts.directives[0].target, { kind: "line", file: TS, line: 6 });
});

Deno.test("parseAcceptanceDirectives: a /* inside a // comment or a regex does not open a block and later directives still parse", () => {
  const parsed = parseAcceptanceDirectives(
    [
      "// loads every file under models/* at startup",
      "// matches **/*.ts",
      "const re = /\\/*/g;",
      "const S = z.object({",
      "  apiKey: z.string(), // swamp-quality-ignore credentials-sensitive-field: vault key name",
      "});",
    ].join("\n"),
    TS,
  );
  assertEquals(parsed.invalid, []);
  assertEquals(parsed.directives.length, 1);
  assertEquals(parsed.directives[0].target, {
    kind: "line",
    file: TS,
    line: 5,
  });
});

Deno.test("parseAcceptanceDirectives: a standalone directive reaches past one blank line, not two", () => {
  const one = parseAcceptanceDirectives(
    "// swamp-quality-ignore deno-command: vendor CLI\n\nnew Deno.Command('x');\n",
    TS,
  );
  assertEquals(one.directives[0].target, { kind: "line", file: TS, line: 3 });
  const two = parseAcceptanceDirectives(
    "// swamp-quality-ignore deno-command: vendor CLI\n\n\nnew Deno.Command('x');\n",
    TS,
  );
  assertEquals(two.directives[0].target, { kind: "line", file: TS, line: 2 });
});

Deno.test("parseAcceptanceDirectives: an unclosed Markdown comment is invalid", () => {
  const parsed = parseAcceptanceDirectives(
    "<!-- swamp-quality-ignore ipv4-address-literals: lab\n10.0.0.1\n",
    MD,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(parsed.invalid[0].problem, "not closed");
});

Deno.test("parseAcceptanceDirectives: the reason is optional, with or without the colon", () => {
  for (
    const line of [
      "new Deno.Command('ls'); // swamp-quality-ignore deno-command",
      "new Deno.Command('ls'); // swamp-quality-ignore deno-command:",
      "new Deno.Command('ls'); // swamp-quality-ignore deno-command :  ",
    ]
  ) {
    const parsed = parseAcceptanceDirectives(`${line}\n`, TS);
    assertEquals(parsed.invalid, [], line);
    assertEquals(parsed.directives, [{
      ruleId: "deno-command",
      target: { kind: "line", file: TS, line: 1 },
      source: "inline",
      declaredAt: { file: TS, line: 1 },
    }], line);
  }
});

Deno.test("parseAcceptanceDirectives: a Markdown comment with no reason accepts the next line", () => {
  const parsed = parseAcceptanceDirectives(
    "<!-- swamp-quality-ignore ipv4-address-literals -->\nGateway: 10.0.0.1\n",
    MD,
  );
  assertEquals(parsed.invalid, []);
  assertEquals(parsed.directives[0].reason, undefined);
  assertEquals(parsed.directives[0].target, {
    kind: "line",
    file: MD,
    line: 2,
  });
});

Deno.test("parseAcceptanceDirectives: an error-level rule with no reason is still invalid", () => {
  const parsed = parseAcceptanceDirectives(
    "eval(x); // swamp-quality-ignore dynamic-code\n",
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(
    parsed.invalid[0].problem,
    "error-level rule and cannot be accepted",
  );
});

Deno.test("parseAcceptanceDirectives: text after the rule id without a colon is malformed", () => {
  const parsed = parseAcceptanceDirectives(
    "x; // swamp-quality-ignore deno-command because reasons\n",
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(
    parsed.invalid[0].problem,
    'expected "swamp-quality-ignore <rule-id>" or "swamp-quality-ignore <rule-id>: <reason>"',
  );
});

Deno.test("parseAcceptanceDirectives: the literal <reason> is reason text like any other", () => {
  const parsed = parseAcceptanceDirectives(
    "x; // swamp-quality-ignore deno-command: <reason>\n",
    TS,
  );
  assertEquals(parsed.invalid, []);
  assertEquals(parsed.directives[0].reason, "<reason>");
});

Deno.test("parseAcceptanceDirectives: the keyword inside a string literal is still no directive, whatever comment-like text precedes it", () => {
  for (
    const line of [
      `const s = "a // b' // swamp-quality-ignore deno-command";`,
      `const s = 'it // is" // swamp-quality-ignore deno-command';`,
      "const s = `x // y // swamp-quality-ignore deno-command`;",
      `const note = "don't // swamp-quality-ignore deno-command";`,
      `const url = 'http://x'; const s = "// swamp-quality-ignore deno-command";`,
    ]
  ) {
    const parsed = parseAcceptanceDirectives(`${line}\n`, TS);
    assertEquals(parsed.directives, [], line);
    assertEquals(parsed.invalid, [], line);
    assertEquals(directiveSpan(line, TS), undefined, line);
  }
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

Deno.test("parseAcceptanceDirectives: bare-specifiers cannot be accepted, and the problem names the import-map fix", () => {
  const parsed = parseAcceptanceDirectives(
    "import x from 'lodash'; // swamp-quality-ignore bare-specifiers: fine\n",
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(
    parsed.invalid[0].problem,
    '"bare-specifiers" is not a rule that can be accepted',
  );
  assertStringIncludes(parsed.invalid[0].problem, "import-map target");
});

Deno.test("parseAcceptanceDirectives: a malformed directive is invalid", () => {
  const parsed = parseAcceptanceDirectives(
    "x; // swamp-quality-ignore\n",
    TS,
  );
  assertEquals(parsed.directives, []);
  assertStringIncludes(parsed.invalid[0].problem, "<rule-id>");
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
  assertStringIncludes(
    validateAcceptance("bare-specifiers", "x", "sidecar")!,
    "not a rule that can be accepted",
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
    "not a rule that can be accepted",
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

/** Sites saying lines 1 to 20 of the named files take a comment, unindented. */
function open(...files: string[]): Record<string, CommentSites> {
  const lines: CommentSites = {};
  for (let l = 1; l <= 20; l++) lines[l] = "";
  return Object.fromEntries(files.map((f) => [f, lines]));
}

Deno.test("acceptanceFor: a site finding in a .ts file is a line comment on its own line above", () => {
  assertEquals(
    acceptanceFor(
      { ruleId: "deno-command", file: "/ext/models/thing.ts", line: 7 },
      "/ext",
      open("/ext/models/thing.ts"),
    ),
    {
      form: "comment",
      file: "/ext/models/thing.ts",
      line: 7,
      position: "line-above",
      text: "// swamp-quality-ignore deno-command",
    },
  );
});

Deno.test("acceptanceFor: a site finding in Markdown is an HTML comment on the line above", () => {
  assertEquals(
    acceptanceFor(
      { ruleId: "ipv4-address-literals", file: "/ext/README.md", line: 3 },
      "/ext",
      open("/ext/README.md"),
    ),
    {
      form: "comment",
      file: "/ext/README.md",
      line: 3,
      position: "line-above",
      text: "<!-- swamp-quality-ignore ipv4-address-literals -->",
    },
  );
});

Deno.test("acceptanceFor: a site finding in a .txt file is one sidecar entry naming the file", () => {
  assertEquals(
    acceptanceFor(
      { ruleId: "ipv4-address-literals", file: "/ext/docs/hosts.txt", line: 2 },
      "/ext",
      {},
    ),
    {
      form: "sidecar",
      file: join("/ext", "quality.yaml"),
      entry: { rule: "ipv4-address-literals", file: "docs/hosts.txt" },
    },
  );
});

Deno.test("acceptanceFor: a .txt finding outside the manifest's directory has none, since the sidecar cannot name it", () => {
  assertEquals(
    acceptanceFor(
      {
        ruleId: "ipv4-address-literals",
        file: "/repo/vaults/hosts.txt",
        line: 2,
      },
      "/repo/extensions/models",
      {},
    ),
    undefined,
  );
});

Deno.test("acceptanceFor: testing-completeness is a header comment at line 1, whatever the barriers", () => {
  assertEquals(
    acceptanceFor(
      { ruleId: "testing-completeness", file: "/ext/models/thing.ts" },
      "/ext",
      {},
    ),
    {
      form: "comment",
      file: "/ext/models/thing.ts",
      line: 1,
      position: "file-header",
      text: "// swamp-quality-ignore testing-completeness",
    },
  );
});

Deno.test("acceptanceFor: none for unacceptable rules, collapsed findings, and a site finding with no line", () => {
  for (
    const finding of [
      { ruleId: "adversarial-review-report", file: "/tmp/r.json" },
      { ruleId: "dynamic-code", file: "/ext/a.ts", line: 1 },
      { ruleId: "bare-specifiers", file: "(multiple files)" },
      { ruleId: "testing-completeness", file: "(2 files)" },
      { ruleId: "deno-command", file: "/ext/models/thing.ts" },
    ]
  ) {
    assertEquals(
      acceptanceFor(finding, "/ext", open("/ext/a.ts", "/ext/models/thing.ts")),
      undefined,
      finding.ruleId,
    );
  }
});

Deno.test("acceptanceFor: none on a line the sites leave out, or in a file they do not name; the text copies the line's indentation", () => {
  const finding = { ruleId: "base64-run", file: TS, line: 3 };
  assertEquals(acceptanceFor(finding, "/ext", { [TS]: { 2: "" } }), undefined);
  assertEquals(acceptanceFor(finding, "/ext", {}), undefined);
  assertEquals(acceptanceFor(finding, "/ext", { [TS]: { 3: "\t  " } }), {
    form: "comment",
    file: TS,
    line: 3,
    position: "line-above",
    text: "\t  // swamp-quality-ignore base64-run",
  });
});

Deno.test("commentSites: no line inside a multi-line template literal, string or block comment, each other line with its indentation", () => {
  const source = [
    "const a = 1;", // 1
    "const t = `x", // 2
    "QQQ", // 3
    "${a}", // 4
    "y`;", // 5
    "/**", // 6
    " * doc", // 7
    " */", // 8
    'const s = "a\\', // 9
    'b";', // 10
    "  const b = `one line`;", // 11
  ].join("\n");
  assertEquals(
    commentSites(source, TS, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    { 1: "", 2: "", 6: "", 9: "", 11: "  " },
  );
  assertEquals(commentSites("const x = ;\n", TS, [1]), {});
});

Deno.test("commentSites: no Markdown line inside a fenced block, through the closing fence", () => {
  const md = [
    "# T", // 1
    "Gateway: 10.0.0.1", // 2
    "```sh", // 3
    "curl http://10.0.0.2", // 4
    "```", // 5
    "  Router: 10.0.0.3", // 6
  ].join("\n");
  assertEquals(commentSites(md, MD, [2, 4, 5, 6]), { 2: "", 6: "  " });
});

Deno.test("commentSites: no line the parser would read as inside a block comment, even where the tokenizer disagrees", () => {
  // The parser reads `/*` in a regex literal as an open block comment and
  // ignores directives until a `*/`; a comment offered there would do
  // nothing.
  const source = [
    "const re = /[/*]/;", // 1
    "new Deno.Command(x);", // 2
    "// */", // 3
    "new Deno.Command(y);", // 4
  ].join("\n");
  assertEquals(commentSites(source, TS, [2, 4]), { 4: "" });
});

Deno.test("commentSites: no Markdown line inside a multi-line HTML comment", () => {
  const md = [
    "<!--", // 1
    "Gateway: 10.0.0.1", // 2
    "-->", // 3
    "Router: 10.0.0.3", // 4
    "<!-- note --> Host: 10.0.0.4", // 5
  ].join("\n");
  assertEquals(commentSites(md, MD, [2, 3, 4, 5]), { 4: "", 5: "" });
});

Deno.test("acceptanceFor: every comment acceptance, applied bottom-up, accepts its finding, including two on one line", () => {
  const cases = [
    {
      file: TS,
      lines: ["a;", 'new Deno.Command("x", ["QQQ"]);', "b;"],
      findings: [
        { ruleId: "deno-command", file: TS, line: 2 },
        { ruleId: "base64-run", file: TS, line: 2 },
      ],
    },
    {
      file: MD,
      lines: ["# T", "Gateway: 10.0.0.1", "Router: 10.0.0.2"],
      findings: [
        { ruleId: "ipv4-address-literals", file: MD, line: 2 },
        { ruleId: "ipv4-address-literals", file: MD, line: 3 },
      ],
    },
    {
      file: TS,
      lines: ["export const x = 1;"],
      findings: [{ ruleId: "testing-completeness", file: TS }],
    },
  ];
  for (const { file, lines, findings } of cases) {
    const sites = {
      [file]: commentSites(
        lines.join("\n"),
        file,
        lines.map((_, i) => i + 1),
      ),
    };
    const acceptances = findings.map((f) => acceptanceFor(f, "/ext", sites));
    const edited = [...lines];
    const ordered = acceptances.map((a, i) => ({ a, i })).sort((x, y) =>
      (y.a?.form === "comment" ? y.a.line : 0) -
      (x.a?.form === "comment" ? x.a.line : 0)
    );
    for (const { a } of ordered) {
      if (a?.form !== "comment") throw new Error(file);
      edited.splice(a.line - 1, 0, a.text);
    }
    const parsed = parseAcceptanceDirectives(edited.join("\n"), file);
    assertEquals(parsed.invalid, [], file);
    // Each finding is reported again where its line now sits.
    const moved = findings.map((f) =>
      "line" in f && f.line !== undefined
        ? {
          ...f,
          line: f.line +
            acceptances.filter((a) => a?.form === "comment" && a.line <= f.line)
              .length,
        }
        : f
    );
    const applied = applyAcceptances(moved, parsed.directives);
    assertEquals(applied.remaining, [], file);
    assertEquals(applied.stale, [], file);
  }
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

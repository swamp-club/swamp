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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  type AcceptableFinding,
  ACCEPTANCE_DIRECTIVE,
  type AcceptanceDirective,
  applyAcceptances,
  MAX_ACCEPTANCE_REASON_LENGTH,
  parseAcceptanceDirectives,
} from "./extension_acceptances.ts";
import { RULE_CATALOG } from "./extension_rule_catalog.ts";

const FILE = "/ext/models/thing.ts";

const siteRuleIds = RULE_CATALOG.filter((r) =>
  r.acceptable && r.scope === "site"
).map((r) => r.id);

/** A reason: printable, no newline, within the cap, trimmed non-empty. */
const reasonArb = fc.stringMatching(/^[a-zA-Z0-9 ,.()-]{1,200}$/)
  .map((s) => s.trim())
  .filter((s) =>
    s.length > 0 && s.length <= MAX_ACCEPTANCE_REASON_LENGTH &&
    !/[A-Za-z0-9+/=]{100,}/.test(s)
  );

Deno.test("acceptance property: a rendered trailing directive parses back to the same rule, reason and line", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...siteRuleIds),
      reasonArb,
      fc.integer({ min: 1, max: 40 }),
      (ruleId, reason, lineNumber) => {
        const lines: string[] = [];
        for (let i = 1; i < lineNumber; i++) lines.push(`const v${i} = ${i};`);
        lines.push(
          `doThing(); // ${ACCEPTANCE_DIRECTIVE} ${ruleId}: ${reason}`,
        );
        const parsed = parseAcceptanceDirectives(lines.join("\n"), FILE);
        assertEquals(parsed.invalid, []);
        assertEquals(parsed.directives.length, 1);
        assertEquals(parsed.directives[0].ruleId, ruleId);
        assertEquals(parsed.directives[0].reason, reason);
        assertEquals(parsed.directives[0].target, {
          kind: "line",
          file: FILE,
          line: lineNumber,
        });
      },
    ),
  );
});

Deno.test("acceptance property: a standalone directive always targets the next line", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...siteRuleIds),
      reasonArb,
      fc.integer({ min: 1, max: 40 }),
      fc.stringMatching(/^[ \t]{0,6}$/),
      (ruleId, reason, lineNumber, indent) => {
        const lines: string[] = [];
        for (let i = 1; i < lineNumber; i++) lines.push(`const v${i} = ${i};`);
        lines.push(`${indent}// ${ACCEPTANCE_DIRECTIVE} ${ruleId}: ${reason}`);
        lines.push("doThing();");
        const parsed = parseAcceptanceDirectives(lines.join("\n"), FILE);
        assertEquals(parsed.invalid, []);
        assertEquals(parsed.directives[0].target, {
          kind: "line",
          file: FILE,
          line: lineNumber + 1,
        });
      },
    ),
  );
});

Deno.test("acceptance property: a reason over the cap is always rejected", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...siteRuleIds),
      fc.integer({
        min: MAX_ACCEPTANCE_REASON_LENGTH + 1,
        max: MAX_ACCEPTANCE_REASON_LENGTH * 3,
      }),
      (ruleId, length) => {
        const parsed = parseAcceptanceDirectives(
          `x; // ${ACCEPTANCE_DIRECTIVE} ${ruleId}: ${"r".repeat(length)}\n`,
          FILE,
        );
        assertEquals(parsed.directives, []);
        assertEquals(parsed.invalid.length, 1);
      },
    ),
  );
});

Deno.test("acceptance property: the parser never throws on arbitrary text", () => {
  fc.assert(
    fc.property(fc.string(), (content) => {
      parseAcceptanceDirectives(content, FILE);
      parseAcceptanceDirectives(content, "/ext/README.md");
      parseAcceptanceDirectives(content, "/ext/hosts.txt");
    }),
  );
});

const findingArb: fc.Arbitrary<AcceptableFinding> = fc.record({
  ruleId: fc.constantFrom(
    ...siteRuleIds,
    "bare-specifiers",
    "testing-completeness",
  ),
  file: fc.constantFrom("/ext/a.ts", "/ext/b.ts", "/ext/c.md"),
  line: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
});

const directiveArb: fc.Arbitrary<AcceptanceDirective> = fc.record({
  ruleId: fc.constantFrom(
    ...siteRuleIds,
    "bare-specifiers",
    "testing-completeness",
  ),
  reason: fc.constant("because"),
  target: fc.oneof(
    fc.record({
      kind: fc.constant("line" as const),
      file: fc.constantFrom("/ext/a.ts", "/ext/b.ts", "/ext/c.md"),
      line: fc.integer({ min: 1, max: 6 }),
    }),
    fc.record({
      kind: fc.constant("file" as const),
      file: fc.constantFrom("/ext/a.ts", "/ext/b.ts", "/ext/c.md"),
    }),
    fc.record({ kind: fc.constant("extension" as const) }),
  ),
  source: fc.constantFrom("inline" as const, "sidecar" as const),
  declaredAt: fc.constant({ file: "/ext/a.ts", line: 1 }),
});

Deno.test("acceptance property: accepted plus remaining is exactly the input, in order", () => {
  fc.assert(
    fc.property(
      fc.array(findingArb, { maxLength: 12 }),
      fc.array(directiveArb, { maxLength: 6 }),
      (findings, directives) => {
        const result = applyAcceptances(findings, directives);
        assertEquals(
          result.accepted.length + result.remaining.length,
          findings.length,
        );
        const seen = new Set<AcceptableFinding>([
          ...result.remaining,
          ...result.accepted.map((a) => a.finding),
        ]);
        assertEquals(seen.size, findings.length);
        for (const f of findings) assertEquals(seen.has(f), true);
        // Each stale directive is one that covers no finding.
        for (const d of result.stale) {
          assertEquals(directives.includes(d), true);
        }
      },
    ),
  );
});

Deno.test("acceptance property: a finding no directive names by rule, file and line always remains", () => {
  fc.assert(
    fc.property(
      fc.array(findingArb, { maxLength: 12 }),
      fc.array(directiveArb, { maxLength: 6 }),
      (findings, directives) => {
        const result = applyAcceptances(findings, directives);
        for (const f of result.accepted) {
          const named = directives.some((d) =>
            d.ruleId === f.finding.ruleId && (
              d.target.kind === "extension" ||
              (d.target.kind === "file" && d.target.file === f.finding.file) ||
              (d.target.kind === "line" && d.target.file === f.finding.file &&
                d.target.line === f.finding.line)
            )
          );
          assertEquals(named, true);
        }
      },
    ),
  );
});

Deno.test("acceptance property: with no directives nothing is accepted and nothing is stale", () => {
  fc.assert(
    fc.property(fc.array(findingArb, { maxLength: 12 }), (findings) => {
      const result = applyAcceptances(findings, []);
      assertEquals(result.remaining, findings);
      assertEquals(result.accepted, []);
      assertEquals(result.stale, []);
    }),
  );
});

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

import { assert, assertEquals } from "@std/assert";
import {
  findRule,
  isAcceptableRule,
  isKnownRule,
  remediationFor,
  RULE_CATALOG,
} from "./extension_rule_catalog.ts";
import {
  DEFAULT_REVIEW_RULES,
  isBlockingSeverity,
} from "./extension_review_rules.ts";
import {
  DEFAULT_CONTENT_RULES,
  SAFETY_ERROR_RULE_IDS,
  SAFETY_WARNING_RULE_IDS,
} from "./extension_safety_analyzer.ts";

Deno.test("RULE_CATALOG: ids are unique", () => {
  const ids = RULE_CATALOG.map((r) => r.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("RULE_CATALOG: no error-level rule is acceptable", () => {
  for (const rule of RULE_CATALOG) {
    if (rule.severity === "error") {
      assertEquals(rule.acceptable, false, rule.id);
      assertEquals(isAcceptableRule(rule.id), false, rule.id);
    }
  }
});

Deno.test("RULE_CATALOG: every warning-level rule carries remediation", () => {
  for (const rule of RULE_CATALOG) {
    if (rule.severity === "warning") {
      assert(
        rule.remediation !== undefined && rule.remediation.length > 0,
        `${rule.id} has no remediation`,
      );
    }
  }
});

Deno.test("RULE_CATALOG: the adversarial-review family and the acceptance meta rules are never acceptable", () => {
  for (
    const id of [
      "adversarial-review-report",
      "adversarial-review-dimension-issue",
      "stale-acceptance",
      "invalid-acceptance",
    ]
  ) {
    assert(isKnownRule(id), id);
    assertEquals(isAcceptableRule(id), false, id);
  }
});

Deno.test("isAcceptableRule: unknown ids are never acceptable", () => {
  assertEquals(isAcceptableRule("no-such-rule"), false);
  assertEquals(isKnownRule("no-such-rule"), false);
  assertEquals(findRule("no-such-rule"), undefined);
  assertEquals(remediationFor("no-such-rule"), undefined);
});

Deno.test("isAcceptableRule: the six site-scoped and the file-scoped warnings are acceptable; bare-specifiers is not", () => {
  for (
    const id of [
      "credentials-sensitive-field",
      "schema-strictness",
      "deno-command",
      "base64-run",
      "long-line",
      "ipv4-address-literals",
      "testing-completeness",
    ]
  ) {
    assertEquals(isAcceptableRule(id), true, id);
  }
  assertEquals(isAcceptableRule("bare-specifiers"), false);
});

Deno.test("RULE_CATALOG: agrees with DEFAULT_REVIEW_RULES ids and severities", () => {
  for (const rule of DEFAULT_REVIEW_RULES) {
    const entry = findRule(rule.id);
    assert(entry !== undefined, `${rule.id} missing from the catalog`);
    assertEquals(
      entry.severity,
      isBlockingSeverity(rule.severity) ? "error" : "warning",
      rule.id,
    );
  }
});

Deno.test("RULE_CATALOG: agrees with the safety analyzer's rule ids and severities", () => {
  for (const id of SAFETY_WARNING_RULE_IDS) {
    const entry = findRule(id);
    assert(entry !== undefined, `${id} missing from the catalog`);
    assertEquals(entry.severity, "warning", id);
  }
  for (const id of SAFETY_ERROR_RULE_IDS) {
    const entry = findRule(id);
    assert(entry !== undefined, `${id} missing from the catalog`);
    assertEquals(entry.severity, "error", id);
  }
  for (const rule of DEFAULT_CONTENT_RULES) {
    const entry = findRule(rule.id);
    assert(entry !== undefined, `${rule.id} missing from the catalog`);
    assertEquals(entry.severity, rule.severity, rule.id);
  }
});

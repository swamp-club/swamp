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
  evaluateGrantCondition,
  MAX_AST_DEPTH,
  MAX_CONDITION_COST,
  type PrincipalContext,
  validateGrantCondition,
} from "./grant_condition_environment.ts";

const PRINCIPAL: PrincipalContext = {
  sub: "user-123",
  email: "alice@example.com",
  groups: ["release-managers", "platform"],
  collectives: ["acme", "ops"],
};

// --- Validation: valid conditions per resource kind ---

Deno.test("validateGrantCondition: workflow tags condition", () => {
  const result = validateGrantCondition(
    'tags.env == "staging"',
    "workflow",
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: workflow name condition", () => {
  const result = validateGrantCondition('name == "deploy"', "workflow");
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: workflow collective condition", () => {
  const result = validateGrantCondition(
    'collective == "acme"',
    "workflow",
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: model modelType condition", () => {
  const result = validateGrantCondition('modelType == "aws/ec2"', "model");
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: data ns and tags condition", () => {
  const result = validateGrantCondition(
    'ns == "infra" && tags.env == "prod"',
    "data",
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: data owner condition", () => {
  const result = validateGrantCondition(
    "owner.createdBy == principal.sub",
    "data",
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: access name condition", () => {
  const result = validateGrantCondition('name == "admin-grant"', "access");
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: principal context access", () => {
  const result = validateGrantCondition(
    '"acme" in principal.collectives',
    "workflow",
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: compound condition", () => {
  const result = validateGrantCondition(
    'tags.env == "staging" && collective in principal.collectives',
    "workflow",
  );
  assertEquals(result, { valid: true });
});

// --- Validation: type errors caught ---

Deno.test("validateGrantCondition: rejects typo field (tag instead of tags)", () => {
  const result = validateGrantCondition('tag.env == "staging"', "workflow");
  assertEquals(result.valid, false);
  assertEquals(typeof result.error, "string");
});

Deno.test("validateGrantCondition: rejects field not available for resource kind", () => {
  const result = validateGrantCondition('ns == "infra"', "workflow");
  assertEquals(result.valid, false);
});

Deno.test("validateGrantCondition: rejects unknown top-level field", () => {
  const result = validateGrantCondition(
    'nonexistent.field == "value"',
    "workflow",
  );
  assertEquals(result.valid, false);
});

// --- Validation: syntax errors ---

Deno.test("validateGrantCondition: rejects invalid syntax", () => {
  const result = validateGrantCondition("name ==", "workflow");
  assertEquals(result.valid, false);
  assertEquals(result.error?.startsWith("CEL syntax error:"), true);
});

Deno.test("validateGrantCondition: rejects unclosed string", () => {
  const result = validateGrantCondition('name == "unclosed', "workflow");
  assertEquals(result.valid, false);
});

// --- Validation: length limit ---

Deno.test("validateGrantCondition: rejects condition over 1KB", () => {
  const condition = "a".repeat(1025);
  const result = validateGrantCondition(condition, "workflow");
  assertEquals(result.valid, false);
  assertEquals(result.error?.includes("maximum length"), true);
});

Deno.test("validateGrantCondition: accepts condition at exactly 1KB", () => {
  const padding = " ".repeat(1024 - 'name == "x"'.length);
  const condition = `name == "x"${padding}`;
  assertEquals(condition.length, 1024);
  const result = validateGrantCondition(condition, "workflow");
  assertEquals(result, { valid: true });
});

// --- Seal tests: no I/O receivers ---

Deno.test("validateGrantCondition: seal rejects data.latest()", () => {
  const result = validateGrantCondition(
    'data.latest("model", "data") == "value"',
    "workflow",
  );
  assertEquals(result.valid, false);
});

Deno.test("validateGrantCondition: seal rejects file.contents()", () => {
  const result = validateGrantCondition(
    'file.contents("model", "spec") == "value"',
    "workflow",
  );
  assertEquals(result.valid, false);
});

Deno.test("validateGrantCondition: seal rejects vault.get()", () => {
  const result = validateGrantCondition(
    'vault.get("secret") == "value"',
    "workflow",
  );
  assertEquals(result.valid, false);
});

Deno.test("validateGrantCondition: seal rejects env.HOME", () => {
  const result = validateGrantCondition('env.HOME == "/root"', "workflow");
  assertEquals(result.valid, false);
});

Deno.test("validateGrantCondition: seal rejects arbitrary unknown variable", () => {
  const result = validateGrantCondition(
    "someExtension.func() == true",
    "workflow",
  );
  assertEquals(result.valid, false);
});

// --- Evaluation ---

Deno.test("evaluateGrantCondition: returns true when condition matches", () => {
  const result = evaluateGrantCondition(
    'tags.env == "staging"',
    "workflow",
    { name: "deploy", tags: { env: "staging" }, collective: "acme" },
    PRINCIPAL,
  );
  assertEquals(result, true);
});

Deno.test("evaluateGrantCondition: returns false when condition does not match", () => {
  const result = evaluateGrantCondition(
    'tags.env == "prod"',
    "workflow",
    { name: "deploy", tags: { env: "staging" }, collective: "acme" },
    PRINCIPAL,
  );
  assertEquals(result, false);
});

Deno.test("evaluateGrantCondition: evaluates principal context", () => {
  const result = evaluateGrantCondition(
    '"acme" in principal.collectives',
    "workflow",
    { name: "deploy", tags: {}, collective: "acme" },
    PRINCIPAL,
  );
  assertEquals(result, true);
});

Deno.test("evaluateGrantCondition: evaluates principal.sub", () => {
  const result = evaluateGrantCondition(
    "owner.createdBy == principal.sub",
    "data",
    {
      name: "report",
      ns: "default",
      tags: {},
      owner: { createdBy: "user-123" },
    },
    PRINCIPAL,
  );
  assertEquals(result, true);
});

Deno.test("evaluateGrantCondition: evaluates compound condition", () => {
  const result = evaluateGrantCondition(
    'tags.env == "staging" && "ops" in principal.collectives',
    "workflow",
    { name: "deploy", tags: { env: "staging" }, collective: "acme" },
    PRINCIPAL,
  );
  assertEquals(result, true);
});

Deno.test("evaluateGrantCondition: returns false for non-boolean result", () => {
  const result = evaluateGrantCondition(
    "name",
    "access",
    { name: "admin-grant" },
    PRINCIPAL,
  );
  assertEquals(result, false);
});

Deno.test("evaluateGrantCondition: arithmetic works with mixed types", () => {
  const result = evaluateGrantCondition(
    "size(principal.groups) > 1",
    "workflow",
    { name: "deploy", tags: {}, collective: "acme" },
    PRINCIPAL,
  );
  assertEquals(result, true);
});

// --- RESOURCE_FIELDS fix: model name and tags now valid ---

Deno.test("validateGrantCondition: model name condition", () => {
  const result = validateGrantCondition('name == "my-model"', "model");
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: model tags condition", () => {
  const result = validateGrantCondition('tags.env == "prod"', "model");
  assertEquals(result, { valid: true });
});

// --- AST depth limit ---

Deno.test("validateGrantCondition: accepts condition at max AST depth", () => {
  const terms = Array.from(
    { length: MAX_AST_DEPTH },
    (_, i) => `name == "${String.fromCharCode(97 + (i % 26))}"`,
  );
  const condition = terms.join(" && ");
  const result = validateGrantCondition(condition, "workflow");
  assertEquals(result.valid, true);
});

Deno.test("validateGrantCondition: rejects condition exceeding AST depth", () => {
  const terms = Array.from(
    { length: MAX_AST_DEPTH + 1 },
    (_, i) => `name == "${String.fromCharCode(97 + (i % 26))}"`,
  );
  const condition = terms.join(" && ");
  const result = validateGrantCondition(condition, "workflow");
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "AST depth");
});

Deno.test("validateGrantCondition: realistic grant condition passes depth check", () => {
  const result = validateGrantCondition(
    'principal.sub == "admin" || (tags.env == "prod" && collective == "acme")',
    "workflow",
  );
  assertEquals(result, { valid: true });
});

// --- Comprehension nesting limit ---

Deno.test("validateGrantCondition: accepts single comprehension", () => {
  const result = validateGrantCondition(
    "[1, 2, 3].exists(x, x > 1)",
    "workflow",
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: accepts comprehension nesting at limit", () => {
  const result = validateGrantCondition(
    "[1, 2, 3].filter(x, x > 0).exists(y, y > 1)",
    "workflow",
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: rejects comprehension nesting exceeding limit", () => {
  const result = validateGrantCondition(
    "[1, 2, 3].filter(x, x > 0).filter(y, y > 0).exists(z, z > 1)",
    "workflow",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "comprehension nesting");
});

// --- Cost budget ---

Deno.test("validateGrantCondition: accepts condition within cost budget", () => {
  const result = validateGrantCondition(
    'name == "deploy" && tags.env == "prod" && collective == "acme"',
    "workflow",
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: rejects condition exceeding cost budget", () => {
  const terms = Array.from(
    { length: Math.ceil(MAX_CONDITION_COST / 3) + 1 },
    (_, i) => `name == "${i}"`,
  );
  const condition = terms.join(" || ");
  if (condition.length > 1024) {
    return;
  }
  const result = validateGrantCondition(condition, "workflow");
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "cost budget");
});

// --- matches() validation ---

Deno.test("validateGrantCondition: accepts matches with literal pattern", () => {
  const result = validateGrantCondition(
    'name.matches("^deploy-.*")',
    "workflow",
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: rejects matches with non-literal pattern", () => {
  const result = validateGrantCondition(
    "name.matches(collective)",
    "workflow",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "string literal");
});

Deno.test("validateGrantCondition: rejects matches with catastrophic backtracking pattern", () => {
  const result = validateGrantCondition(
    'name.matches("(a+)+$")',
    "workflow",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "catastrophic backtracking");
});

Deno.test("validateGrantCondition: rejects matches with invalid regex", () => {
  const result = validateGrantCondition(
    'name.matches("[invalid")',
    "workflow",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "not a valid regular expression");
});

Deno.test("validateGrantCondition: accepts matches with simple character class", () => {
  const result = validateGrantCondition(
    'name.matches("^[a-z]+-[0-9]+$")',
    "workflow",
  );
  assertEquals(result, { valid: true });
});

// --- Combined: first failure wins ---

Deno.test("validateGrantCondition: reports first failure when multiple limits exceeded", () => {
  const terms = Array.from(
    { length: MAX_AST_DEPTH + 1 },
    (_, i) => `name == "${i}"`,
  );
  const condition = terms.join(" && ");
  const result = validateGrantCondition(condition, "workflow");
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "AST depth");
});

// --- Existing conditions still pass ---

Deno.test("validateGrantCondition: all existing condition patterns pass cost bounds", () => {
  const conditions: [string, string][] = [
    ['tags.env == "staging"', "workflow"],
    ['name == "deploy"', "workflow"],
    ['collective == "acme"', "workflow"],
    ['modelType == "aws/ec2"', "model"],
    ['ns == "infra" && tags.env == "prod"', "data"],
    ["owner.createdBy == principal.sub", "data"],
    ['name == "admin-grant"', "access"],
    ['"acme" in principal.collectives', "workflow"],
    [
      'tags.env == "staging" && collective in principal.collectives',
      "workflow",
    ],
  ];
  for (const [condition, kind] of conditions) {
    const result = validateGrantCondition(
      condition,
      kind as "workflow" | "model" | "data" | "access",
    );
    assertEquals(result, { valid: true }, `Failed for: ${condition}`);
  }
});

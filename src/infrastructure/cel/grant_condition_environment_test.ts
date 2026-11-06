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
  MAX_AST_DEPTH,
  MAX_CONDITION_LENGTH,
  readConditionFindings,
  readConditionTypeLiterals,
  validateGrantCondition,
} from "./grant_condition_environment.ts";

const EFFECTS = ["allow", "deny"] as const;

for (const effect of EFFECTS) {
  for (
    const condition of [
      "!run.initiator.sub",
      'run.serveDriven == "false"',
      "run.initiator.sub > 1",
      'principal.sub == "x" && !run.initiator.sub',
      'principal.sub == "x" || !run.initiator.sub',
      "false && !run.initiator.sub",
      'run.initiator == "alice"',
      'run.initiator in ["a"]',
      "run.initiator != null",
      "run.initiator.sub == null",
      'run.serveDriven in ["a"]',
      "run.initiator.sub ? true : false",
      "size(run.serveDriven) > 0",
      'run.serveDriven.startsWith("a")',
      'run.initiator.sub + 1 == "a"',
      "[run.initiator.sub].exists(x, x > 1)",
      "cel.bind(x, run.initiator.sub, !x)",
      "run.initiator.sub",
      "run.initiator",
      'run.serveDriven ? "a" : "b"',
      "dyn(run.initiator.sub) > 1",
      "!dyn(run.initiator.sub)",
      "int(run.initiator.sub) > 1",
      'timestamp(run.initiator.sub) > timestamp("2020-01-01T00:00:00Z")',
      "tags.env > 1 && run.serveDriven",
      "principal.sub > 1 && run.serveDriven",
      'principal.email == "a" && run.serveDriven',
    ]
  ) {
    Deno.test(`validateGrantCondition: refuses on a ${effect}, naming run: ${condition}`, () => {
      const result = validateGrantCondition(condition, "workflow", {
        actions: ["approve"],
        effect,
      });
      assertEquals(result.valid, false);
      assertStringIncludes(result.error!, "Condition");
    });
  }

  for (
    const condition of [
      "dyn(client) > 1",
      "client",
      'client == "direct:" && principal.sub > 1',
      'client == "direct:" && tags.env > 1',
      "int(client) > 1",
    ]
  ) {
    Deno.test(`validateGrantCondition: refuses on a ${effect}, naming client: ${condition}`, () => {
      const result = validateGrantCondition(condition, "workflow", {
        actions: ["read"],
        effect,
      });
      assertEquals(result.valid, false);
    });
  }

  for (
    const condition of [
      "principal.sub == run.initiator.sub",
      "run.serveDriven",
      "!run.serveDriven",
      "run.serveDriven == true",
      "principal.sub == run.initiator.sub || !run.serveDriven",
      'run.initiator.kind == "user"',
      'run.initiator.id.startsWith("a")',
      'run.initiator.sub in ["a", "b"]',
      "run.initiator.sub in principal.groups",
      "has(run.initiator.sub)",
      '"sub" in run.initiator',
      "size(run.initiator) > 0",
      "size(run.initiator.sub) > 0",
      "run.serveDriven ? true : false",
      '(run.serveDriven ? run.initiator.sub : run.initiator.id) == "a"',
      'run.initiator.sub.matches("a")',
      'run.initiator == {"kind": "user"}',
      '"env" in tags && tags.env == "a" && run.serveDriven',
      'int(tags.count) > 5 && run.initiator.kind == "user"',
      "1 / 0 == 1 && run.serveDriven",
      "cel.bind(x, run.initiator.sub, int(x) > 1)",
    ]
  ) {
    Deno.test(`validateGrantCondition: accepts on a ${effect}: ${condition}`, () => {
      const result = validateGrantCondition(condition, "workflow", {
        actions: ["approve"],
        effect,
      });
      assertEquals(result.error, undefined);
      assertEquals(result.valid, true);
    });
  }

  for (
    const condition of [
      "!principal.sub",
      "principal.sub > 1",
      "principal.sub == 1",
      'principal.subb == "a"',
      'principal.email == "a"',
      '"a" in principal.sub',
      'principal.groups == "a"',
      "principal.sub ? true : false",
      "!tags.env",
      "tags.env > 1",
      "tags.env == 1",
      "tags.env ? true : false",
      "tags.exists(k, k > 1)",
      "name",
      "tags.env",
      "principal.sub",
    ]
  ) {
    Deno.test(`validateGrantCondition: a ${effect} on older fields stays valid and warns: ${condition}`, () => {
      const result = validateGrantCondition(condition, "workflow", {
        actions: ["read"],
        effect,
      });
      assertEquals(result.valid, true);
      assertEquals(
        result.warnings?.some((w) => w.startsWith("Condition")),
        true,
      );
      assertEquals(
        readConditionFindings(condition, "workflow").typeIssue !== undefined,
        true,
      );
    });
  }
}

Deno.test("validateGrantCondition: a variable a macro binds is not the run", () => {
  assertEquals(
    validateGrantCondition("[1].exists(run, run > 0)", "workflow", {
      actions: ["read"],
      effect: "deny",
    }),
    { valid: true },
  );
});

Deno.test("validateGrantCondition: existing refusals keep their messages over the type check", () => {
  assertStringIncludes(
    validateGrantCondition("!run.initiatr.sub", "workflow", {
      actions: ["approve"],
      effect: "deny",
    }).error!,
    "which a run does not have",
  );
  assertStringIncludes(
    validateGrantCondition("!run.initiator.sub", "workflow", {
      actions: ["read"],
      effect: "deny",
    }).error!,
    "names run",
  );
});

Deno.test("validateGrantCondition: the refusal says what is wrong and how to fix it", () => {
  const { error } = validateGrantCondition("!run.initiator.sub", "workflow", {
    actions: ["approve"],
    effect: "deny",
  });
  assertStringIncludes(error!, "cannot evaluate");
  assertStringIncludes(error!, "as a deny");
  assertStringIncludes(error!, "principal.sub == run.initiator.sub");
});

Deno.test("validateGrantCondition: a deny reading a tag with no guard warns; an allow or a guard does not", () => {
  const warningsFor = (condition: string, effect: "allow" | "deny") =>
    validateGrantCondition(condition, "workflow", {
      actions: ["read"],
      effect,
    }).warnings;
  assertStringIncludes(
    warningsFor('tags.env == "prod"', "deny")![0],
    "tags.env without checking the tag exists",
  );
  assertStringIncludes(
    warningsFor('tags["env"] == "prod"', "deny")![0],
    "tags.env",
  );
  assertEquals(warningsFor('tags.env == "prod"', "allow"), undefined);
  assertEquals(
    warningsFor('"env" in tags && tags.env == "prod"', "deny"),
    undefined,
  );
  assertEquals(
    warningsFor('has(tags.env) && tags.env == "prod"', "deny"),
    undefined,
  );
  assertEquals(
    warningsFor('tags.exists(k, tags[k] == "x")', "deny"),
    undefined,
  );
  assertStringIncludes(
    warningsFor('"env" in tags && tags.team == "a"', "deny")![0],
    "tags.team",
  );
});

Deno.test("readConditionFindings: reads as nothing for a condition it cannot parse or that is too long", () => {
  assertEquals(readConditionFindings("tags.env ==", "workflow"), {
    unguardedTags: [],
  });
  assertEquals(
    readConditionFindings(`"${"a".repeat(MAX_CONDITION_LENGTH)}"`, "workflow"),
    { unguardedTags: [] },
  );
  assertEquals(readConditionFindings('name == "x"', "workflow"), {
    unguardedTags: [],
  });
});

Deno.test("readConditionFindings: names a stored condition that would not be accepted now", () => {
  assertStringIncludes(
    readConditionFindings("!run.initiator.sub", "workflow").typeIssue!,
    "cannot evaluate",
  );
  assertEquals(
    readConditionFindings('tags.env == "x"', "workflow").unguardedTags,
    ["env"],
  );
});

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

Deno.test("validateGrantCondition: rejects invalid syntax", () => {
  const result = validateGrantCondition("name ==", "workflow");
  assertEquals(result.valid, false);
  assertEquals(result.error?.startsWith("CEL syntax error:"), true);
});

Deno.test("validateGrantCondition: rejects unclosed string", () => {
  const result = validateGrantCondition('name == "unclosed', "workflow");
  assertEquals(result.valid, false);
});

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

Deno.test("validateGrantCondition: model name condition", () => {
  const result = validateGrantCondition('name == "my-model"', "model");
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: model tags condition", () => {
  const result = validateGrantCondition('tags.env == "prod"', "model");
  assertEquals(result, { valid: true });
});

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

Deno.test("validateGrantCondition: accepts condition within cost budget", () => {
  const result = validateGrantCondition(
    'name == "deploy" && tags.env == "prod" && collective == "acme"',
    "workflow",
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateGrantCondition: rejects condition exceeding cost budget", () => {
  const listElements = Array.from({ length: 50 }, () => "1").join(",");
  const clause = `[${listElements}].all(x, true)`;
  const clauses = Array.from({ length: 8 }, () => clause);
  const condition = clauses.join(" && ");
  assertEquals(
    condition.length <= 1024,
    true,
    "test condition must fit in 1KB",
  );
  const result = validateGrantCondition(condition, "workflow");
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "cost budget");
});

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

Deno.test("validateGrantCondition: all existing condition patterns pass cost bounds", () => {
  const conditions: [string, string][] = [
    ['tags.env == "staging"', "workflow"],
    ['name == "deploy"', "workflow"],
    ['collective == "acme"', "workflow"],
    ['modelType == "aws/ec2"', "model"],
    ['methodName == "read"', "model"],
    ['methodName in ["read", "list"]', "model"],
    ['methodName == "read" && modelType == "aws/ec2"', "model"],
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

Deno.test("readConditionTypeLiterals: finds literals compared with modelType", () => {
  assertEquals(
    readConditionTypeLiterals(
      `modelType == "AWS::EC2::VPC" || "x/y" != modelType || modelType in ["A/b", name] || (modelType.startsWith("Acme.") && modelType.endsWith("Probe"))`,
      "model",
    ),
    [
      { literal: "AWS::EC2::VPC", match: "exact" },
      { literal: "x/y", match: "exact" },
      { literal: "A/b", match: "exact" },
      { literal: "Acme.", match: "prefix" },
      { literal: "Probe", match: "fragment" },
    ],
  );
});

Deno.test("readConditionTypeLiterals: ignores literals compared with other fields", () => {
  assertEquals(
    readConditionTypeLiterals(`name == "Prod" && tags.env == "A::B"`, "model"),
    [],
  );
});

Deno.test("readConditionTypeLiterals: reads name on access resources only", () => {
  assertEquals(readConditionTypeLiterals(`name == "@swamp/grant"`, "access"), [
    { literal: "@swamp/grant", match: "exact" },
  ]);
  assertEquals(readConditionTypeLiterals(`name == "X::Y"`, "workflow"), []);
});

Deno.test("readConditionTypeLiterals: returns no literals for a condition that does not parse", () => {
  assertEquals(readConditionTypeLiterals(`modelType == `, "model"), []);
});

const APPROVE_DENY = { actions: ["approve"], effect: "deny" } as const;

Deno.test("validateGrantCondition: the run is valid only for a workflow's approve", () => {
  const condition = "principal.sub == run.initiator.sub";
  assertEquals(
    validateGrantCondition(condition, "workflow", APPROVE_DENY).valid,
    true,
  );
  for (
    const actions of [["run"], ["approve", "read"], ["signal"]] as const
  ) {
    const result = validateGrantCondition(condition, "workflow", {
      actions,
      effect: "deny",
    });
    assertEquals(result.valid, false);
    assertStringIncludes(result.error!, "names run");
  }
  assertEquals(validateGrantCondition(condition, "model").valid, false);
  assertEquals(validateGrantCondition(condition, "data").valid, false);
});

Deno.test("validateGrantCondition: the client is valid on every kind and every action", () => {
  for (
    const kind of ["workflow", "model", "data", "access", "vault"] as const
  ) {
    const result = validateGrantCondition(
      'client != "integration:slack"',
      kind,
      { actions: ["read", "write", "run"], effect: "deny" },
    );
    assertEquals(result, { valid: true });
  }
});

Deno.test("validateGrantCondition: a client literal no token can hold is refused, and a direct id warns", () => {
  assertEquals(
    validateGrantCondition('client == "integration:Slack"', "workflow").valid,
    false,
  );
  assertEquals(
    validateGrantCondition('client == "slack"', "data").valid,
    false,
  );
  const direct = validateGrantCondition('client != "direct:cli"', "data");
  assertEquals(direct.valid, true);
  assertStringIncludes(direct.warnings![0], "not a security boundary");
  assertEquals(
    validateGrantCondition('client.startsWith("direct:")', "data").warnings,
    undefined,
  );
});

Deno.test("validateGrantCondition: a vault allow on the client warns that it limits runs and never matches in one", () => {
  const allow = validateGrantCondition(
    'client == "integration:slack"',
    "vault",
    { actions: ["read"], effect: "allow" },
  );
  assertEquals(allow.valid, true);
  assertStringIncludes(allow.warnings![0], "inside a run");
  assertEquals(
    validateGrantCondition('client == "integration:slack"', "vault", {
      actions: ["read"],
      effect: "deny",
    }).warnings,
    undefined,
  );
});

Deno.test("validateGrantCondition: a binder named client or run names no new field", () => {
  for (
    const condition of [
      'tags.exists(client, client == "x")',
      'tags.exists(run, run == "x")',
    ]
  ) {
    assertEquals(
      validateGrantCondition(condition, "workflow", {
        actions: ["read"],
        effect: "deny",
      }),
      { valid: true },
    );
  }
});

Deno.test("validateGrantCondition: a path the run does not have is refused, since a deny that errors does not fire", () => {
  for (
    const condition of [
      "principal.sub == run.initiatr.sub",
      'run.initiator.subject == "x"',
      "run.serve_driven",
      'run["initiator"].sub == "x"',
      'run.initiator["subz"] == "x"',
      "run == {}",
    ]
  ) {
    const result = validateGrantCondition(condition, "workflow", APPROVE_DENY);
    assertEquals(result.valid, false, condition);
    assertStringIncludes(result.error!, "which a run does not have");
  }
  for (
    const condition of [
      "principal.sub == run.initiator.sub",
      'run.initiator.kind == "service"',
      'run.initiator.id == "scheduler"',
      "!run.serveDriven",
    ]
  ) {
    assertEquals(
      validateGrantCondition(condition, "workflow", APPROVE_DENY).valid,
      true,
      condition,
    );
  }
});

Deno.test("validateGrantCondition: a client prefix no token can hold is refused", () => {
  for (
    const prefix of [
      "integration:Slack",
      "integration:-x",
      "slack",
      "direct:nope",
    ]
  ) {
    assertEquals(
      validateGrantCondition(`client.startsWith("${prefix}")`, "data").valid,
      false,
      prefix,
    );
  }
  for (const prefix of ["integration:", "integration:sl", "direct:", "dir"]) {
    assertEquals(
      validateGrantCondition(`client.startsWith("${prefix}")`, "data").valid,
      true,
      prefix,
    );
  }
});

Deno.test("validateGrantCondition: a client prefix naming a direct id warns", () => {
  assertStringIncludes(
    validateGrantCondition('client.startsWith("direct:cli")', "data")
      .warnings![0],
    "not a security boundary",
  );
  assertEquals(
    validateGrantCondition('client.startsWith("direct:")', "data").warnings,
    undefined,
  );
});

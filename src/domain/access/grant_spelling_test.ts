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
import { readConditionTypeLiterals } from "../../infrastructure/cel/grant_condition_environment.ts";
import { findGrantSpellingIssues } from "./grant_spelling.ts";

Deno.test("findGrantSpellingIssues: canonical selectors have no findings", () => {
  for (const pattern of ["@acme/*", "aws/ec2/*", "*", "prod-db", "acme/*"]) {
    assertEquals(
      findGrantSpellingIssues({
        effect: "allow",
        resource: { kind: "model", pattern },
      }),
      [],
    );
  }
});

Deno.test("findGrantSpellingIssues: names the canonical spelling of a model selector", () => {
  for (
    const [pattern, canonical] of [
      ["@Acme/*", "model:@acme/*"],
      ["AWS::EC2::*", "model:aws/ec2/*"],
      ["Acme.Tools.Probe", "model:acme/tools/probe"],
    ]
  ) {
    const [finding] = findGrantSpellingIssues({
      effect: "allow",
      resource: { kind: "model", pattern },
    });
    assertEquals(finding.part, "selector");
    assertEquals(finding.canonical, canonical);
    assertStringIncludes(finding.message, "matches no model type");
  }
});

Deno.test("findGrantSpellingIssues: says a deny matches in any spelling", () => {
  const [finding] = findGrantSpellingIssues({
    effect: "deny",
    resource: { kind: "model", pattern: "AWS::EC2::*" },
  });
  assertStringIncludes(finding.message, "a deny matches any spelling");
});

Deno.test("findGrantSpellingIssues: access selectors are checked only when they name a control-plane type", () => {
  const [finding] = findGrantSpellingIssues({
    effect: "deny",
    resource: { kind: "access", pattern: "@swamp/grant" },
  });
  assertEquals(finding.canonical, "access:swamp/grant");
  assertEquals(
    findGrantSpellingIssues({
      effect: "deny",
      resource: { kind: "access", pattern: "@Swamp/*" },
    })[0].canonical,
    "access:swamp/*",
  );
  for (const pattern of ["access.grant.list", "*", "swamp/grant", "grant"]) {
    assertEquals(
      findGrantSpellingIssues({
        effect: "allow",
        resource: { kind: "access", pattern },
      }),
      [],
    );
  }
});

Deno.test("findGrantSpellingIssues: workflow, data and vault selectors are never checked", () => {
  for (const kind of ["workflow", "data", "vault"] as const) {
    assertEquals(
      findGrantSpellingIssues({
        effect: "deny",
        resource: { kind, pattern: "AWS::EC2::*" },
      }),
      [],
    );
  }
});

Deno.test("findGrantSpellingIssues: names the canonical spelling of modelType literals", () => {
  const findings = findGrantSpellingIssues(
    {
      effect: "deny",
      resource: { kind: "model", pattern: "*" },
      condition:
        `modelType == "AWS::EC2::VPC" || modelType.startsWith("Acme::") || modelType.endsWith("Probe") || modelType == "exp/probe"`,
    },
    readConditionTypeLiterals,
  );
  assertEquals(findings.map((f) => [f.written, f.canonical]), [
    ["AWS::EC2::VPC", "aws/ec2/vpc"],
    ["Acme::", "acme/"],
    ["Probe", "probe"],
  ]);
});

Deno.test("findGrantSpellingIssues: access name literals are checked only for control-plane types", () => {
  const findings = findGrantSpellingIssues(
    {
      effect: "deny",
      resource: { kind: "access", pattern: "*" },
      condition: `name == "@swamp/grant" || name == "access.grant.list"`,
    },
    readConditionTypeLiterals,
  );
  assertEquals(findings.map((f) => [f.written, f.canonical]), [
    ["@swamp/grant", "swamp/grant"],
  ]);
});

Deno.test("findGrantSpellingIssues: conditions are skipped without a literal reader", () => {
  assertEquals(
    findGrantSpellingIssues({
      effect: "deny",
      resource: { kind: "model", pattern: "*" },
      condition: `modelType == "AWS::EC2::VPC"`,
    }),
    [],
  );
});

Deno.test("findGrantSpellingIssues: an allow message reads a wildcard as a pattern", () => {
  const [wildcard] = findGrantSpellingIssues({
    effect: "allow",
    resource: { kind: "model", pattern: "@Acme/*" },
  });
  assertStringIncludes(wildcard.message, "model names matching '@Acme/*'");
  const [exact] = findGrantSpellingIssues({
    effect: "allow",
    resource: { kind: "model", pattern: "AWS::EC2::VPC" },
  });
  assertStringIncludes(exact.message, "a model named exactly 'AWS::EC2::VPC'");
});

Deno.test("findGrantSpellingIssues: literal messages fit exact, prefix and fragment matches", () => {
  const messages = findGrantSpellingIssues(
    {
      effect: "deny",
      resource: { kind: "model", pattern: "*" },
      condition:
        `modelType == "AWS::EC2::VPC" || modelType.startsWith("Acme::") || modelType.contains("My Probe")`,
    },
    readConditionTypeLiterals,
  ).map((f) => f.message);
  assertStringIncludes(messages[0], "compared with 'AWS::EC2::VPC'");
  assertStringIncludes(messages[0], "write 'aws/ec2/vpc'");
  assertStringIncludes(messages[1], "modelType.startsWith('Acme::')");
  assertStringIncludes(messages[2], "checked for 'My Probe'");
  assertStringIncludes(messages[2], "write 'my/probe'");
});

Deno.test("findGrantSpellingIssues: a deny that may name model names is not told to respell", () => {
  const [finding] = findGrantSpellingIssues({
    effect: "deny",
    resource: { kind: "model", pattern: "Prod-*" },
  });
  assertStringIncludes(
    finding.message,
    "also covers model types spelled 'model:prod-*'",
  );
  assertStringIncludes(
    finding.message,
    "keep it as written if it is meant for those models",
  );
  assertEquals(finding.message.includes("write it that way"), false);
});

Deno.test("findGrantSpellingIssues: an allow that may name model names offers both readings", () => {
  const [finding] = findGrantSpellingIssues({
    effect: "allow",
    resource: { kind: "model", pattern: "Prod-DB" },
  });
  assertStringIncludes(finding.message, "only a model named exactly 'Prod-DB'");
  assertStringIncludes(
    finding.message,
    "keep it as written if it is meant for those models",
  );
});

Deno.test("findGrantSpellingIssues: a type-path deny is told to respell", () => {
  const [finding] = findGrantSpellingIssues({
    effect: "deny",
    resource: { kind: "model", pattern: "AWS::EC2::*" },
  });
  assertStringIncludes(finding.message, "write it that way");
});

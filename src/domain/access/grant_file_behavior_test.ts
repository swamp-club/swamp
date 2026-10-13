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

// The behavior spelling of grant selectors (swamp-club#3334): `behavior:` is
// read as `model:` before anything else sees the selector, and every other
// unknown kind still fails loudly.

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { parseGrantFile } from "./grant_file.ts";
import {
  canonicalResourceSelectorString,
  parseResourceSelector,
  resourceSelectorToString,
} from "./resource_selector.ts";
import {
  readConditionTypeLiterals,
  validateGrantCondition,
} from "../../infrastructure/cel/grant_condition_environment.ts";

Deno.test("parseResourceSelector: behavior is read as model", () => {
  assertEquals(parseResourceSelector("behavior:@acme/*"), {
    kind: "model",
    pattern: "@acme/*",
  });
  assertEquals(
    resourceSelectorToString(parseResourceSelector("behavior:web")),
    "model:web",
  );
});

Deno.test("parseResourceSelector: behaviour, plurals and other near-misses still throw", () => {
  for (
    const kind of [
      "behaviour",
      "behaviors",
      "behaviours",
      "Behavior",
      "BEHAVIOR",
      "behavior ",
      "models",
    ]
  ) {
    const error = assertThrows(
      () => parseResourceSelector(`${kind}:@acme/*`),
      Error,
    );
    assertStringIncludes(error.message, `Invalid resource kind "${kind}"`);
  }
});

Deno.test("canonicalResourceSelectorString: canonical spelling, or the value unchanged when it does not parse", () => {
  assertEquals(canonicalResourceSelectorString("behavior:@x/*"), "model:@x/*");
  assertEquals(canonicalResourceSelectorString("model:@x/*"), "model:@x/*");
  assertEquals(canonicalResourceSelectorString("workflow:w"), "workflow:w");
  assertEquals(canonicalResourceSelectorString("behaviour:x"), "behaviour:x");
  assertEquals(canonicalResourceSelectorString("behavior:"), "behavior:");
  assertEquals(canonicalResourceSelectorString("nocolon"), "nocolon");
});

Deno.test("parseGrantFile: a behavior selector is stored as the model selector", () => {
  const result = parseGrantFile(
    "b.yaml",
    `
grants:
  - subject: user:adam
    effect: deny
    actions: [run]
    resource: "behavior:@acme/*"
`,
  );
  assertEquals(result.errors, []);
  assertEquals(result.entries[0].resource, {
    kind: "model",
    pattern: "@acme/*",
  });
});

Deno.test("parseGrantFile: model:x and behavior:x in one resources list are a duplicate", () => {
  const result = parseGrantFile(
    "dup.yaml",
    `
grants:
  - subject: user:adam
    effect: deny
    actions: [run]
    resources: ["model:@acme/*", "behavior:@acme/*"]
`,
  );
  assertEquals(result.entries, []);
  assertEquals(result.errors.length, 1);
  assertEquals(
    result.errors[0].message,
    'Duplicate resource in resources array: "behavior:@acme/*"',
  );
});

Deno.test("parseGrantFile: model:x and behavior:x as two entries are a duplicate grant", () => {
  const result = parseGrantFile(
    "dup.yaml",
    `
grants:
  - subject: user:adam
    effect: deny
    actions: [run]
    resource: "model:@acme/*"
  - subject: user:adam
    effect: deny
    actions: [run]
    resource: "behavior:@acme/*"
`,
  );
  assertEquals(result.entries.length, 1);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "Duplicate grant entry");
});

Deno.test("parseGrantFile: model-spelled resources lists keep their duplicate and parse errors", () => {
  const dup = parseGrantFile(
    "dup.yaml",
    `
grants:
  - subject: user:adam
    effect: deny
    actions: [run]
    resources: ["model:a", "model:a"]
`,
  );
  assertEquals(
    dup.errors.map((e) => e.message),
    ['Duplicate resource in resources array: "model:a"'],
  );
  // An unparseable selector repeated is still reported as the duplicate it
  // was before, ahead of its parse error.
  const bad = parseGrantFile(
    "bad.yaml",
    `
grants:
  - subject: user:adam
    effect: deny
    actions: [run]
    resources: ["behaviour:a", "behaviour:a"]
`,
  );
  assertEquals(
    bad.errors.map((e) => e.message),
    ['Duplicate resource in resources array: "behaviour:a"'],
  );
});

Deno.test("parseGrantFile: a behaviour selector fails loudly", () => {
  const result = parseGrantFile(
    "typo.yaml",
    `
grants:
  - subject: user:adam
    effect: deny
    actions: [run]
    resource: "behaviour:@acme/*"
`,
  );
  assertEquals(result.entries, []);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(
    result.errors[0].message,
    'Invalid resource kind "behaviour"',
  );
});

Deno.test("parseGrantFile: a modelType condition on a behavior selector is checked as on a model selector", () => {
  const grantWith = (kind: string) =>
    parseGrantFile(
      "c.yaml",
      `
grants:
  - subject: user:adam
    effect: allow
    actions: [run]
    resource: "${kind}:*"
    condition: 'modelType == "Acme.Tools.Probe"'
`,
      validateGrantCondition,
      readConditionTypeLiterals,
    );
  const model = grantWith("model");
  const behavior = grantWith("behavior");
  assertEquals(behavior.errors, model.errors);
  assertEquals(behavior.entries, model.entries);
  assertEquals(behavior.warnings, model.warnings);
  assert(model.warnings.length > 0);
});

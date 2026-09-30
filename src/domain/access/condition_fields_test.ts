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
import { Environment } from "cel-js";
import {
  CONDITION_FIELDS,
  conditionFieldZeroValue,
  referencedConditionFields,
  suppliedResourceFields,
} from "./condition_fields.ts";

function ast(condition: string): unknown {
  const env = new Environment({ unlistedVariablesAreDyn: true });
  return (env.parse(condition) as unknown as { ast: unknown }).ast;
}

Deno.test("referencedConditionFields: finds the fields a condition reads", () => {
  assertEquals(
    referencedConditionFields(
      ast('tags.env == "prod" && name.startsWith("db-")'),
      "model",
    ).sort(),
    ["name", "tags"],
  );
});

Deno.test("referencedConditionFields: ignores principal and undeclared names", () => {
  assertEquals(
    referencedConditionFields(ast('principal.sub == "u"'), "model"),
    [],
  );
  assertEquals(
    referencedConditionFields(ast('ns == "acme"'), "model"),
    [],
  );
});

Deno.test("referencedConditionFields: a member name is not a reference", () => {
  assertEquals(
    referencedConditionFields(ast('tags.name == "x"'), "model"),
    ["tags"],
  );
});

Deno.test("referencedConditionFields: excludes names bound by a comprehension", () => {
  assertEquals(
    referencedConditionFields(
      ast('principal.groups.exists(owner, owner == "x")'),
      "data",
    ),
    [],
  );
  assertEquals(
    referencedConditionFields(
      ast("principal.groups.exists(g, g == ns)"),
      "data",
    ),
    ["ns"],
  );
});

Deno.test("referencedConditionFields: finds fields inside has() and ternaries", () => {
  assertEquals(
    referencedConditionFields(
      ast('has(tags.env) ? tags.env == "prod" : methodName == "run"'),
      "model",
    ).sort(),
    ["methodName", "tags"],
  );
});

Deno.test("CONDITION_FIELDS: methodName is the only request field", () => {
  const request = Object.values(CONDITION_FIELDS).flat().filter((f) =>
    f.role === "request"
  ).map((f) => f.name);
  assertEquals([...new Set(request)], ["methodName"]);
});

Deno.test("suppliedResourceFields: excludes request and unsupplied fields", () => {
  assertEquals(suppliedResourceFields("model"), ["name", "modelType", "tags"]);
  assertEquals(suppliedResourceFields("data"), ["name", "ns", "tags"]);
  assertEquals(suppliedResourceFields("workflow"), ["name", "tags"]);
  assertEquals(suppliedResourceFields("access"), ["name"]);
});

Deno.test("conditionFieldZeroValue: maps are empty, strings are empty", () => {
  assertEquals(conditionFieldZeroValue("map"), {});
  assertEquals(conditionFieldZeroValue("string"), "");
});

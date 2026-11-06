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
import {
  CONDITION_FIELDS,
  conditionFieldAbsentValue,
  conditionFieldsUnavailableForActions,
  conditionFieldZeroValue,
  referencedConditionFields,
  suppliedResourceFields,
} from "./condition_fields.ts";
import type { Action } from "./action.ts";
import { assertEquals } from "@std/assert";
import { Environment } from "cel-js";

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

Deno.test("CONDITION_FIELDS: methodName, a vault's key and the client are the only request fields", () => {
  const request = Object.values(CONDITION_FIELDS).flat().filter((f) =>
    f.role === "request"
  ).map((f) => f.name);
  assertEquals([...new Set(request)].sort(), ["client", "key", "methodName"]);
});

Deno.test("CONDITION_FIELDS: a vault is decided by its name, with the request's key", () => {
  assertEquals(
    CONDITION_FIELDS.vault.map((f) => [f.name, f.role, f.supplied]),
    [
      ["name", "resource", true],
      ["key", "request", true],
      ["client", "request", true],
    ],
  );
});

Deno.test("suppliedResourceFields: excludes request and unsupplied fields", () => {
  assertEquals(suppliedResourceFields("model"), ["name", "modelType", "tags"]);
  assertEquals(suppliedResourceFields("data"), ["name", "ns", "tags"]);
  assertEquals(suppliedResourceFields("workflow"), ["name", "tags"]);
  assertEquals(suppliedResourceFields("access"), ["name"]);
  assertEquals(suppliedResourceFields("vault"), ["name"]);
});

Deno.test("conditionFieldZeroValue: maps are empty, strings are empty", () => {
  assertEquals(conditionFieldZeroValue("map"), {});
  assertEquals(conditionFieldZeroValue("string"), "");
});

Deno.test("CONDITION_FIELDS: every kind reads the client, and an absent one reads as direct", () => {
  for (const fields of Object.values(CONDITION_FIELDS)) {
    const client = fields.find((f) => f.name === "client");
    assertEquals(client?.role, "request");
    assertEquals(conditionFieldAbsentValue(client!), "direct:");
  }
});

Deno.test("CONDITION_FIELDS: only a workflow's approve decision can supply the run, as a resource field", () => {
  const holders = Object.entries(CONDITION_FIELDS).filter(([, fields]) =>
    fields.some((f) => f.name === "run")
  );
  assertEquals(holders.map(([kind]) => kind), ["workflow"]);
  const run = CONDITION_FIELDS.workflow.find((f) => f.name === "run")!;
  assertEquals(run.role, "resource");
  assertEquals(run.actions, ["approve"]);
});

Deno.test("conditionFieldsUnavailableForActions: names the run for any action but approve", () => {
  const ast = {
    op: "==",
    args: [
      { op: ".", args: [{ op: "id", args: "run" }, "initiator"] },
      { op: "value", args: "x" },
    ],
  };
  assertEquals(
    conditionFieldsUnavailableForActions(ast, "workflow", ["approve"]),
    [],
  );
  for (
    const actions of [["run"], ["approve", "read"], ["signal"]] as Action[][]
  ) {
    assertEquals(
      conditionFieldsUnavailableForActions(ast, "workflow", actions).map((u) =>
        u.field
      ),
      ["run"],
    );
  }
});

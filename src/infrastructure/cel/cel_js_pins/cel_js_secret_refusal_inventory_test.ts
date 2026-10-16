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

import { assertEquals, assertThrows } from "@std/assert";
import { Environment } from "cel-js";
import {
  ALLOWED_OPERATOR_SIGNATURES,
  classifyPositions,
  functionRefusalSignatures,
  operatorRefusalSignatures,
  parseSignature,
  qualifiedName,
  secretCapableBuiltins,
  specialDispositionNames,
} from "./cel_js_secret_refusal_inventory.ts";

Deno.test("parseSignature: splits receiver, name, parameters and return type", () => {
  assertEquals(parseSignature("size(string): int"), {
    signature: "size(string): int",
    receiverType: null,
    name: "size",
    params: ["string"],
    returnType: "int",
  });
  assertEquals(
    parseSignature("google.protobuf.Timestamp.getDate(string): int"),
    {
      signature: "google.protobuf.Timestamp.getDate(string): int",
      receiverType: "google.protobuf.Timestamp",
      name: "getDate",
      params: ["string"],
      returnType: "int",
    },
  );
  assertEquals(
    parseSignature("CelWorkersNamespace.connected(): dyn").params,
    [],
  );
});

Deno.test("parseSignature: keeps a comma inside a parameterized type together", () => {
  const parsed = parseSignature(
    "map<dyn, dyn>.lookup(map<string, list<dyn>>, int): dyn",
  );
  assertEquals(parsed.receiverType, "map<dyn, dyn>");
  assertEquals(parsed.params, ["map<string, list<dyn>>", "int"]);
  assertEquals(qualifiedName(parsed), "map<dyn, dyn>.lookup");
});

Deno.test("parseSignature: rejects a signature without a return type", () => {
  assertThrows(
    () => parseSignature("size(string)"),
    Error,
    "Invalid signature: size(string)",
  );
});

Deno.test("classifyPositions: a string position is a refusal unless the function is type()", () => {
  assertEquals(classifyPositions("string.indexOf(string, int): int"), [
    {
      signature: "string.indexOf(string, int): int",
      position: "receiver",
      type: "string",
      disposition: "refusal",
    },
    {
      signature: "string.indexOf(string, int): int",
      position: 0,
      type: "string",
      disposition: "refusal",
    },
  ]);
  assertEquals(
    classifyPositions("type(string): type")[0].disposition,
    "type-name",
  );
  assertEquals(classifyPositions("int(int): int"), []);
});

Deno.test("classifyPositions: named deliveries, argument walks and containers come from the table", () => {
  const method = classifyPositions(
    "CelModelNamespace.method(string, string, dyn): dyn",
  );
  assertEquals(method.map((p) => p.disposition), [
    "refusal",
    "refusal",
    "named-delivery",
  ]);
  const vary = classifyPositions(
    "CelDataNamespace.latest(string, string, list<dyn>): dyn",
  );
  assertEquals(vary.map((p) => p.disposition), [
    "refusal",
    "refusal",
    "argument-walk",
  ]);
  const join = classifyPositions("list<string>.join(string): string");
  assertEquals(join.map((p) => [p.position, p.disposition]), [
    ["receiver", "container"],
    [0, "refusal"],
  ]);
  assertEquals(classifyPositions("CelNamespace.bind(ast, dyn, ast): dyn"), [
    {
      signature: "CelNamespace.bind(ast, dyn, ast): dyn",
      position: 1,
      type: "dyn",
      disposition: "named-delivery",
    },
  ]);
});

Deno.test("classifyPositions: an unnamed dyn or list position is the alarm", () => {
  assertThrows(
    () => classifyPositions("format(list<dyn>): string"),
    Error,
    "Unclassified secret-capable position in format(list<dyn>): string: 0 is list<dyn>",
  );
  assertThrows(
    () => classifyPositions("CelDataNamespace.query(dyn): dyn"),
    Error,
    "Unclassified secret-capable position in CelDataNamespace.query(dyn): dyn: 0 is dyn",
  );
  assertThrows(
    () => classifyPositions("list<dyn>.first(): dyn"),
    Error,
    "receiver is list<dyn>",
  );
});

Deno.test("functionRefusalSignatures: every non-empty subset of the refusal positions, sorted and unique", () => {
  assertEquals(
    functionRefusalSignatures([
      "CelDataNamespace.latest(string, string): dyn",
      "CelDataNamespace.latest(string, string): dyn",
    ]),
    [
      "CelDataNamespace.latest(Secret, Secret): dyn",
      "CelDataNamespace.latest(Secret, string): dyn",
      "CelDataNamespace.latest(string, Secret): dyn",
    ],
  );
  assertEquals(
    functionRefusalSignatures(["list<string>.join(string): string"]),
    [
      "list<string>.join(Secret): string",
    ],
  );
  assertEquals(
    functionRefusalSignatures(["int(int): int", "type(string): type"]),
    [],
  );
  assertEquals(
    functionRefusalSignatures(["string.indexOf(string, int): int"]).length,
    3,
  );
});

Deno.test("operatorRefusalSignatures: excludes the allowed set and adds custom equality types", () => {
  const plain = operatorRefusalSignatures();
  for (const allowed of ALLOWED_OPERATOR_SIGNATURES) {
    assertEquals(plain.includes(allowed), false, allowed);
  }
  assertEquals(plain.includes("Secret == string"), true);
  assertEquals(plain.includes("string == Secret"), false, "mirrored by cel-js");
  assertEquals(plain.includes("Secret < string"), true);
  assertEquals(plain.includes("string < Secret"), true);
  assertEquals(plain.includes("!Secret"), true);
  assertEquals(plain.includes("Secret in list"), false);
  const custom = operatorRefusalSignatures(["Ns", "Secret"]);
  assertEquals(custom.length, plain.length + 1);
  assertEquals(custom.includes("Secret == Ns"), true);
});

Deno.test("secretCapableBuiltins: keeps a function only when a Secret can reach it", () => {
  const env = new Environment().registerFunction("f(int): int", () => 1n, {
    async: false,
  }).registerFunction("g(string): int", () => 1n, { async: false });
  const names = secretCapableBuiltins(env).map((fn) => fn.name);
  assertEquals(names.includes("g"), true);
  assertEquals(names.includes("f"), false);
});

Deno.test("specialDispositionNames: is sorted and names only qualified functions", () => {
  const names = specialDispositionNames();
  assertEquals(names, [...names].sort());
  for (const name of names) {
    assertEquals(/^[A-Za-z_<>.]+$/.test(name), true, name);
  }
});

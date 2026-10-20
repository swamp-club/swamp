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
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { runInFaultScope, SecretRefusal } from "./secret_fault_context.ts";
import {
  composeSecrets,
  dataReferenceSecret,
  isSecret,
  Secret,
  secretFromParts,
  secretParts,
  vaultReferenceSecret,
} from "./secret_value.ts";

const reference = { vaultName: "prod", key: "DB_PASS" };

Deno.test("vaultReferenceSecret: holds one vault reference and its location", () => {
  const secret = vaultReferenceSecret(reference, "methods.run.arguments.a");
  assertEquals(secretParts(secret), [
    { reference, dataOrigin: false, location: "methods.run.arguments.a" },
  ]);
  assert(isSecret(secret));
  assert(secret instanceof Secret);
  assertStrictEquals(secret.constructor, Secret);
});

Deno.test("isSecret and secretParts: recognize only this module's instances, never a shape", () => {
  for (const value of [new Secret(), {}, "x", null, undefined, 1, []]) {
    assertEquals(isSecret(value), false);
    assertEquals(secretParts(value), undefined);
  }
});

Deno.test("composeSecrets: joins parts in order, merging adjacent text", () => {
  const a = vaultReferenceSecret(reference, "a");
  const b = vaultReferenceSecret({ vaultName: "prod", key: "TOKEN" }, "b");
  const composed = composeSecrets(composeSecrets("x", a), "y");
  const both = composeSecrets(composeSecrets(composed, "z"), b);
  const [ref] = secretParts(a)!;
  const [refB] = secretParts(b)!;
  assertEquals(secretParts(both), ["x", ref, "yz", refB]);
  // A part keeps its identity across compositions.
  assertStrictEquals(secretParts(both)![1], ref);
  assertStrictEquals(secretParts(both)![3], refB);
});

Deno.test("secretFromParts: drops empty text and refuses parts with no reference", () => {
  const secret = secretFromParts(["", { reference, dataOrigin: true }, ""]);
  assertEquals(secretParts(secret), [{ reference, dataOrigin: true }]);
  assertThrows(
    () => secretFromParts(["a", "b"]),
    Error,
    "A secret holds at least one reference",
  );
});

Deno.test("Secret: enumeration and descriptors refuse with a fault", () => {
  const secret = vaultReferenceSecret(reference, "a");
  runInFaultScope((scope) => {
    assertThrows(() => Object.keys(secret), SecretRefusal, "ownKeys");
    assertThrows(
      () => Object.getOwnPropertyDescriptor(secret, "x"),
      SecretRefusal,
      "getOwnPropertyDescriptor",
    );
    assertEquals(scope.faults.map((fault) => fault.operation), [
      "ownKeys",
      "getOwnPropertyDescriptor",
    ]);
    // Cloning reads a descriptor, so it refuses with a fault too.
    assertThrows(() => structuredClone(secret));
    assertEquals(scope.faults.length, 3);
  });
});

Deno.test("Secret: conversion to text or a primitive refuses with a fault", () => {
  const secret = vaultReferenceSecret(reference, "a");
  runInFaultScope((scope) => {
    assertThrows(() => String(secret), SecretRefusal);
    assertThrows(() => `${secret}`, SecretRefusal);
    assertThrows(() => JSON.stringify(secret), SecretRefusal);
    assertThrows(() => (secret as unknown as number) + 1, SecretRefusal);
    assertThrows(
      () => (secret as unknown as { valueOf(): unknown }).valueOf(),
      SecretRefusal,
    );
    assertEquals(scope.faults.map((fault) => fault.operation), [
      "Symbol(Symbol.toPrimitive)",
      "Symbol(Symbol.toPrimitive)",
      "toJSON",
      "Symbol(Symbol.toPrimitive)",
      "valueOf",
    ]);
  });
});

Deno.test("Secret: awaiting it and reading any other key is harmless and records nothing", async () => {
  const secret = vaultReferenceSecret(reference, "a");
  await runInFaultScope(async (scope) => {
    assertStrictEquals(await Promise.resolve(secret), secret);
    const keyed = secret as unknown as Record<string | symbol, unknown>;
    assertEquals(keyed.then, undefined);
    assertEquals(keyed.password, undefined);
    assertEquals(keyed[Symbol.for("Deno.customInspect")], undefined);
    assertEquals("password" in keyed, false);
    assertEquals(scope.faults, []);
  });
});

Deno.test("Secret: Deno.inspect prints the class name without reading the state", () => {
  const secret = vaultReferenceSecret(reference, "a");
  runInFaultScope((scope) => {
    const shown = Deno.inspect(secret);
    assert(shown.includes("Secret"), shown);
    assert(!shown.includes("DB_PASS"), shown);
    assertEquals(scope.faults, []);
  });
});

Deno.test("dataReferenceSecret: holds one data-origin reference and where it was read", () => {
  const location =
    "data.latest of model 'db' record r1 version 2 (data.latest), field 'password'";
  const secret = dataReferenceSecret(reference, location);
  assertEquals(secretParts(secret), [
    { reference, dataOrigin: true, location },
  ]);
  assert(isSecret(secret));
  assertStrictEquals(secret.constructor, Secret);
});

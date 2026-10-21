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

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  SECRET_DESTINATION_REFUSED,
  SECRET_OPERATION_UNSUPPORTED,
} from "../../domain/expressions/errors.ts";
import {
  currentFaultScope,
  recordBoundaryFailure,
  recordedFaults,
  recordFault,
  recordSecretRead,
  recordSensitiveReference,
  refuse,
  runInFaultScope,
  SecretRefusal,
} from "./secret_fault_context.ts";

Deno.test("runInFaultScope: records faults and secret reads into the scope it hands over", () => {
  const scope = runInFaultScope((scope) => {
    assertEquals(recordFault("Secret == string"), true);
    recordFault("the vary values", SECRET_DESTINATION_REFUSED);
    recordSecretRead();
    recordSecretRead();
    assertStrictEquals(recordedFaults(), scope.faults);
    return scope;
  });
  assertEquals(scope.faults, [
    { operation: "Secret == string", code: SECRET_OPERATION_UNSUPPORTED },
    { operation: "the vary values", code: SECRET_DESTINATION_REFUSED },
  ]);
  assertEquals(scope.secretsRead, 2);
});

Deno.test("runInFaultScope: a read after recording stops is not counted", () => {
  const scope = runInFaultScope((scope) => {
    recordSecretRead();
    scope.recording = false;
    recordSecretRead();
    return scope;
  });
  assertEquals(scope.secretsRead, 1);
});

Deno.test("runInFaultScope: a fault recorded after an await lands in the scope that started the work", async () => {
  const [first, second] = await Promise.all([
    runInFaultScope(async (scope) => {
      await Promise.resolve();
      recordFault("first");
      return scope;
    }),
    runInFaultScope(async (scope) => {
      recordFault("second");
      await Promise.resolve();
      return scope;
    }),
  ]);
  assertEquals(first.faults.map((fault) => fault.operation), ["first"]);
  assertEquals(second.faults.map((fault) => fault.operation), ["second"]);
});

Deno.test("recordFault: outside a scope the fault is dropped", () => {
  assertEquals(recordFault("Secret == string"), false);
  assertEquals(recordedFaults(), undefined);
  recordSecretRead();
  recordBoundaryFailure(new Error("ignored"));
});

Deno.test("refuse: records the fault, then throws a value-free refusal with its code", () => {
  runInFaultScope((scope) => {
    const error = assertThrows(
      () => refuse("size(Secret): int"),
      SecretRefusal,
      "A secret refuses size(Secret): int (secret_operation_unsupported)",
    );
    assertEquals(error.code, SECRET_OPERATION_UNSUPPORTED);
    assertEquals(scope.faults, [
      { operation: "size(Secret): int", code: SECRET_OPERATION_UNSUPPORTED },
    ]);
  });
  assertThrows(() => refuse("outside"), SecretRefusal);
});

Deno.test("recordBoundaryFailure: keeps the first failure", () => {
  const first = new Error("first");
  const scope = runInFaultScope((scope) => {
    recordBoundaryFailure(first);
    recordBoundaryFailure(new Error("second"));
    return scope;
  });
  assertStrictEquals(scope.boundaryFailure, first);
});

Deno.test("recordSensitiveReference: records each reference once by vault and key, whether or not recording is on", () => {
  const scope = runInFaultScope((scope) => {
    recordSensitiveReference({ vaultName: "v", key: "a" });
    scope.recording = false;
    recordSensitiveReference({ vaultName: "v", key: "a" });
    recordSensitiveReference({ vaultName: "v", key: "b" });
    return scope;
  });
  assertEquals([...scope.sensitiveReferences.entries()], [
    ["v\u0000a", { vaultName: "v", key: "a" }],
    ["v\u0000b", { vaultName: "v", key: "b" }],
  ]);
  assertEquals(scope.secretsRead, 0);
  assertEquals(scope.faults, []);
});

Deno.test("recordSensitiveReference: outside a scope the read fails closed", () => {
  assertThrows(
    () => recordSensitiveReference({ vaultName: "v", key: "a" }),
    Error,
    "outside an expression evaluation",
  );
});

Deno.test("runInFaultScope: a fresh scope has no container comparison and no release, and currentFaultScope answers it inside and nothing outside", () => {
  assertEquals(currentFaultScope(), undefined);
  runInFaultScope((scope) => {
    assertEquals(scope.containerComparison, false);
    assertEquals(scope.release, undefined);
    assertEquals(currentFaultScope(), scope);
    scope.containerComparison = true;
    scope.release = (value) => value;
    assertEquals(currentFaultScope()?.containerComparison, true);
  });
  assertEquals(currentFaultScope(), undefined);
});

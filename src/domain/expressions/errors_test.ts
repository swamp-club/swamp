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

import { assertEquals, assertInstanceOf } from "@std/assert";
import { modelWording } from "../behavior_wording.ts";
import { UserError } from "../errors.ts";
import {
  CyclicDependencyError,
  ExpressionError,
  InvalidExpressionError,
  ModelNotFoundError,
  SECRET_DESTINATION_REFUSED,
  SECRET_OPERATION_UNSUPPORTED,
  SECRET_REFERENCE_INVALID,
  SecretRefusedError,
  UnresolvedExpressionError,
} from "./errors.ts";

Deno.test("ExpressionError stores message and optional fields", () => {
  const error = new ExpressionError(
    "Test error",
    "model.foo.input.x",
    "attributes.value",
  );

  assertEquals(error.message, "Test error");
  assertEquals(error.expression, "model.foo.input.x");
  assertEquals(error.path, "attributes.value");
  assertEquals(error.name, "ExpressionError");
});

Deno.test("ExpressionError handles undefined optional fields", () => {
  const error = new ExpressionError("Test error");

  assertEquals(error.message, "Test error");
  assertEquals(error.expression, undefined);
  assertEquals(error.path, undefined);
});

Deno.test("ExpressionError stores cause", () => {
  const cause = new Error("Root cause");
  const error = new ExpressionError("Wrapper", undefined, undefined, cause);

  assertEquals(error.cause, cause);
});

Deno.test("ModelNotFoundError contains model ref in message", () => {
  const error = new ModelNotFoundError("missing-model");

  assertEquals(error.message, "Behavior not found: missing-model");
  assertEquals(modelWording(error), "Model not found: missing-model");
  assertEquals(error.modelRef, "missing-model");
  assertEquals(error.name, "ModelNotFoundError");
  assertInstanceOf(error, ExpressionError);
});

Deno.test("ModelNotFoundError stores expression and path", () => {
  const error = new ModelNotFoundError(
    "foo",
    "model.foo.input.x",
    "attributes.ref",
  );

  assertEquals(error.modelRef, "foo");
  assertEquals(error.expression, "model.foo.input.x");
  assertEquals(error.path, "attributes.ref");
});

Deno.test("InvalidExpressionError contains message prefix", () => {
  const error = new InvalidExpressionError("syntax error at position 5");

  assertEquals(error.message, "Invalid expression: syntax error at position 5");
  assertEquals(error.name, "InvalidExpressionError");
  assertInstanceOf(error, ExpressionError);
});

Deno.test("InvalidExpressionError stores all fields", () => {
  const cause = new SyntaxError("Unexpected token");
  const error = new InvalidExpressionError(
    "parse failed",
    "invalid ++ syntax",
    "attributes.expr",
    cause,
  );

  assertEquals(error.expression, "invalid ++ syntax");
  assertEquals(error.path, "attributes.expr");
  assertEquals(error.cause, cause);
});

Deno.test("CyclicDependencyError shows cycle path", () => {
  const error = new CyclicDependencyError(["a", "b", "c", "a"]);

  assertEquals(error.message, "Cyclic dependency detected: a -> b -> c -> a");
  assertEquals(error.cycle, ["a", "b", "c", "a"]);
  assertEquals(error.name, "CyclicDependencyError");
  assertInstanceOf(error, ExpressionError);
});

Deno.test("CyclicDependencyError handles two-node cycle", () => {
  const error = new CyclicDependencyError(["x", "y", "x"]);

  assertEquals(error.message, "Cyclic dependency detected: x -> y -> x");
  assertEquals(error.cycle.length, 3);
});

Deno.test("UnresolvedExpressionError: builds its model spelling from a worded cause", () => {
  const error = new UnresolvedExpressionError(
    "${{ model.x.resource }}",
    "methods.run.arguments.a",
    new ModelNotFoundError("x"),
  );
  assertEquals(
    error.message,
    "Expression in methods.run.arguments.a could not be evaluated: Behavior not found: x",
  );
  assertEquals(
    modelWording(error),
    "Expression in methods.run.arguments.a could not be evaluated: Model not found: x",
  );
});

Deno.test("UnresolvedExpressionError: a cause without a model spelling leaves none", () => {
  const error = new UnresolvedExpressionError("e", "p", new Error("boom"));
  assertEquals(modelWording(error), undefined);
});

Deno.test("SecretRefusedError: a UserError carrying its stable code, the operation and the expression, with no cause", () => {
  const error = new SecretRefusedError(
    SECRET_OPERATION_UNSUPPORTED,
    "Secret == string",
    "inputs.token == 'x'",
  );
  assertInstanceOf(error, UserError);
  assertEquals(error.code, "secret_operation_unsupported");
  assertEquals(error.operation, "Secret == string");
  assertEquals(error.expression, "inputs.token == 'x'");
  assertEquals(error.cause, undefined);
  assertEquals(error.name, "SecretRefusedError");
  assertEquals(
    error.message,
    "Expression refused a secret (secret_operation_unsupported): Secret == string, in inputs.token == 'x'",
  );
  assertEquals(
    new SecretRefusedError(SECRET_DESTINATION_REFUSED, "a", "b").code,
    "secret_destination_refused",
  );
});

Deno.test("SecretRefusedError: secret_reference_invalid is a stable code, and its message reads as a record error", () => {
  const operation =
    "an invalid sensitive-field reference in model 'db' record r1 version 2 (data.latest): field 'password' is not a stored vault reference";
  const error = new SecretRefusedError(
    SECRET_REFERENCE_INVALID,
    operation,
    "data.latest('db', 'main').attributes.password",
  );
  assertInstanceOf(error, UserError);
  assertEquals(error.code, "secret_reference_invalid");
  assertEquals(
    error.message,
    `Expression refused a secret (secret_reference_invalid): ${operation}, in data.latest('db', 'main').attributes.password`,
  );
  assertEquals(error.cause, undefined);
});

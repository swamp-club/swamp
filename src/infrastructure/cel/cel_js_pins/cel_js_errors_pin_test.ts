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

// Pins for error absorption (design/enablers/typed-secrets.md Section 4.2:
// "other missing-overload errors can be absorbed by `||`, `all`, or
// `exists`."). Absorption is CEL's commutative logic: an error on one side is
// discarded only when the other side alone decides the result.

import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import * as celJs from "cel-js";
import {
  Environment,
  EvaluationError,
  ParseError,
  TypeError as CelTypeError,
} from "cel-js";
import {
  assertCelError,
  dynEnvironment,
  FixtureSecret,
  pin,
} from "./cel_js_pin_test_helpers.ts";

class FatalError extends Error {
  override name = "FatalError";
}

function throwingEnvironment(): Environment {
  return dynEnvironment()
    .registerFunction("boom(): bool", () => {
      throw new Error("kaboom");
    })
    .registerFunction("celboom(): bool", () => {
      throw new EvaluationError("celkaboom");
    })
    .registerFunction("fatal(): bool", () => {
      throw new FatalError("fatal!");
    })
    .registerFunction("strboom(): bool", () => {
      throw "a string";
    })
    .registerFunction("aboom(): bool", async () => {
      await Promise.resolve();
      throw new Error("async kaboom");
    })
    .registerFunction("afatal(): bool", async () => {
      await Promise.resolve();
      throw new FatalError("async fatal!");
    })
    .registerFunction("ok(): bool", () => true);
}

Deno.test(
  pin(
    "error || true is true for every runtime error class, including Error subclasses",
  ),
  () => {
    const env = throwingEnvironment();
    for (
      const expression of [
        "boom() || true",
        "true || boom()",
        "fatal() || true",
        "celboom() || true",
        "strboom() || true",
        "(boom() || true) && true",
        "!boom() || true",
        "boom() == true || true",
        "boom() || ok()",
        "ok() || boom()",
        "1 / 0 == 1 || true",
        "has(nope.x) || true",
        "nope.x || true",
        "nope.x == 1 || true",
        "[1][5] == 1 || true",
      ]
    ) {
      assertEquals(env.evaluate(expression, {}), true, expression);
    }
  },
);

Deno.test(pin("an async error || true resolves true"), async () => {
  const env = throwingEnvironment();
  assertEquals(await env.evaluate("aboom() || true", {}), true);
  assertEquals(await env.evaluate("afatal() || true", {}), true);
  assertEquals(await env.evaluate("aboom() && false", {}), false);
});

Deno.test(
  pin(
    "error && false is false, and an error is rethrown when the other side does not decide",
  ),
  () => {
    const env = throwingEnvironment();
    assertEquals(env.evaluate("boom() && false", {}), false);
    assertEquals(env.evaluate("false && boom()", {}), false);
    for (
      const expression of [
        "boom() || false",
        "false || boom()",
        "boom() && true",
        "boom() || boom()",
        "boom() ? 1 : 2",
      ]
    ) {
      assertThrows(() => env.evaluate(expression, {}), Error, "kaboom");
    }
  },
);

Deno.test(
  pin("a statically detectable type error is not absorbed by ||"),
  () => {
    assertCelError(
      () => throwingEnvironment().evaluate("'a' + 1 || true", {}),
      EvaluationError,
      "no_such_overload",
    );
  },
);

Deno.test(
  pin(
    "a runtime missing-overload error is absorbed by || and by a deciding exists element",
  ),
  () => {
    const env = dynEnvironment().registerType("Secret", {
      ctor: FixtureSecret,
      fields: {},
    });
    const s = new FixtureSecret("x");
    assertCelError(
      () => env.evaluate("s + 'x'", { s }),
      EvaluationError,
      "no_such_overload",
    );
    assertCelError(
      () => env.evaluate("s < 1", { s }),
      EvaluationError,
      "no_such_overload",
    );
    assertEquals(env.evaluate("s + 'x' == 'a' || true", { s }), true);
    assertEquals(env.evaluate("s < 1 || true", { s }), true);
    assertEquals(
      env.evaluate("[1, 2].exists(i, i == 2 || s + 'x' == 'a')", { s }),
      true,
    );
    assertEquals(
      env.evaluate("[1, 2].exists(i, s + 'x' == 'a' || i == 2)", { s }),
      true,
    );
    assertEquals(
      env.evaluate("[s, 1].exists(x, x == 1 || x < 1)", { s }),
      true,
    );
    for (
      const expression of [
        "[1].all(i, s + 'x' == 'a')",
        "[1, 2].exists(i, (s + 'x') == 'a')",
        "[s].exists(x, x < 1)",
      ]
    ) {
      assertCelError(
        () => env.evaluate(expression, { s }),
        EvaluationError,
        "no_such_overload",
      );
    }
  },
);

function predicateEnvironment(): Environment {
  return dynEnvironment()
    .registerFunction("pred(int): bool", (x: bigint) => {
      if (x === 1n) throw new Error("pred boom");
      return x === 2n;
    })
    .registerFunction("apred(int): bool", async (x: bigint) => {
      await Promise.resolve();
      if (x === 1n) throw new Error("apred boom");
      return x === 2n;
    });
}

Deno.test(
  pin("exists absorbs a predicate error only when another element is true"),
  async () => {
    const env = predicateEnvironment();
    assertEquals(env.evaluate("[1, 2].exists(x, pred(x))", {}), true);
    assertThrows(
      () => env.evaluate("[1, 3].exists(x, pred(x))", {}),
      Error,
      "pred boom",
    );
    assertEquals(await env.evaluate("[1, 2].exists(x, apred(x))", {}), true);
    await assertRejects(
      () => env.evaluate("[1, 3].exists(x, apred(x))", {}),
      Error,
      "apred boom",
    );
  },
);

Deno.test(
  pin("all absorbs a predicate error only when another element is false"),
  async () => {
    const env = predicateEnvironment();
    assertEquals(env.evaluate("[1, 3].all(x, pred(x))", {}), false);
    assertEquals(env.evaluate("[2].all(x, pred(x))", {}), true);
    assertThrows(
      () => env.evaluate("[1, 2].all(x, pred(x))", {}),
      Error,
      "pred boom",
    );
    assertEquals(await env.evaluate("[1, 3].all(x, apred(x))", {}), false);
  },
);

Deno.test(
  pin("map, filter and exists_one always rethrow a predicate error"),
  () => {
    const env = predicateEnvironment();
    for (
      const expression of [
        "[1, 2].exists_one(x, pred(x))",
        "[1, 2].filter(x, pred(x))",
        "[1, 2].map(x, pred(x))",
      ]
    ) {
      assertThrows(() => env.evaluate(expression, {}), Error, "pred boom");
    }
  },
);

Deno.test(
  pin("an error while building a macro's range is not absorbed"),
  () => {
    const env = throwingEnvironment();
    for (
      const expression of [
        "[boom(), true].exists(x, x)",
        "[true, boom()].exists(x, x)",
        "[boom(), false].all(x, x)",
        "[boom()].map(x, x)",
        "[boom(), true].filter(x, x)",
        "[boom(), true].exists_one(x, x)",
      ]
    ) {
      assertThrows(() => env.evaluate(expression, {}), Error, "kaboom");
    }
  },
);

Deno.test(pin("a handler's Error is rethrown unwrapped, with no range"), () => {
  const error = assertThrows(
    () => throwingEnvironment().evaluate("boom()", {}),
    Error,
    "kaboom",
  );
  assertStrictEquals(error.constructor, Error);
  assertEquals((error as { range?: unknown }).range, undefined);
});

Deno.test(
  pin(
    "there is no fatal error class: an Error subclass is absorbed like any other",
  ),
  async () => {
    const env = throwingEnvironment();
    assertEquals(env.evaluate("fatal() || true", {}), true);
    assertEquals(await env.evaluate("afatal() || true", {}), true);
  },
);

Deno.test(
  pin(
    "ParseError, EvaluationError and TypeError share an unexported base class",
  ),
  () => {
    const env = throwingEnvironment();
    const division = assertCelError(
      () => env.evaluate("1 / 0", {}),
      EvaluationError,
      "division_by_zero",
    );
    assertEquals(division.range, { start: 0, end: 5 });
    assertCelError(
      () => env.evaluate("1 +", {}),
      ParseError,
      "unexpected_token",
    );
    const strictError = new Environment().check("x + 1").error;
    assertInstanceOf(strictError, CelTypeError);
    assertEquals(strictError.code, "unknown_variable");

    const base = Object.getPrototypeOf(EvaluationError);
    assertEquals(base.name, "CelError");
    assertStrictEquals(Object.getPrototypeOf(ParseError), base);
    assertStrictEquals(Object.getPrototypeOf(CelTypeError), base);
    assertStrictEquals(Object.getPrototypeOf(base), Error);
    assertEquals("CelError" in celJs, false);
    assertEquals((CelTypeError as unknown) === globalThis.TypeError, false);
  },
);

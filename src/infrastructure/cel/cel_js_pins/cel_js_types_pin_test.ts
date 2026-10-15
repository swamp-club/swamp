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

// Pins for custom type registration and macro ranges over custom-typed
// values (design/enablers/typed-secrets.md Section 4.2: "fields: {} hides
// secret fields, but comprehension can use Object.keys and return an empty
// range. An opaque class alone is insufficient for refusal.").

import {
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
} from "@std/assert";
import { EvaluationError, Optional, TypeError as CelTypeError } from "cel-js";
import {
  assertCelError,
  assertPlainError,
  dynEnvironment,
  FixtureSecret,
  pin,
  PrivateFieldSecret,
} from "./cel_js_pin_test_helpers.ts";

class FixtureSecretSubclass extends FixtureSecret {}

class UnregisteredValue {
  constructor(readonly v: string) {}
}

/** A secret-like value with two public fields, for macro range tests. */
class TwoFieldSecret {
  constructor(readonly v: string, readonly meta = { k: 1 }) {}
}

Deno.test(
  pin("type() reports the registered name for an exact constructor match"),
  () => {
    const env = dynEnvironment().registerType("Secret", FixtureSecret);
    assertEquals(
      String(env.evaluate("type(s)", { s: new FixtureSecret("hunter2") })),
      "Type<Secret>",
    );
  },
);

Deno.test(
  pin("a subclass of a registered constructor is unsupported_type"),
  () => {
    const env = dynEnvironment().registerType("Secret", FixtureSecret);
    const sub = new FixtureSecretSubclass("x");
    assertCelError(
      () => env.evaluate("type(sub)", { sub }),
      EvaluationError,
      "unsupported_type",
    );
    assertCelError(
      () => env.evaluate("s == sub", { s: new FixtureSecret("a"), sub }),
      EvaluationError,
      "unsupported_type",
    );
  },
);

Deno.test(
  pin("an instance of an unregistered class is unsupported_type"),
  () => {
    assertCelError(
      () =>
        dynEnvironment().evaluate("type(u)", { u: new UnregisteredValue("y") }),
      EvaluationError,
      "unsupported_type",
    );
  },
);

Deno.test(
  pin("a plain object with the same shape is a map, not the custom type"),
  () => {
    const env = dynEnvironment()
      .registerType("Secret", FixtureSecret)
      .registerFunction("Secret.reveal(): string", (s: FixtureSecret) => s.v);
    const plain = { v: "z" };
    assertEquals(String(env.evaluate("type(plain)", { plain })), "Type<map>");
    assertCelError(
      () => env.evaluate("plain.reveal()", { plain }),
      EvaluationError,
      "no_matching_overload",
    );
    assertEquals(
      String(dynEnvironment().evaluate("type(o)", { o: Object.create(null) })),
      "Type<map>",
    );
  },
);

Deno.test(
  pin(
    "registering one constructor under a second name makes the last name win",
  ),
  () => {
    const env = dynEnvironment()
      .registerType("Secret", FixtureSecret)
      .registerType("Secret2", FixtureSecret);
    assertEquals(
      String(env.evaluate("type(s)", { s: new FixtureSecret("a") })),
      "Type<Secret2>",
    );
  },
);

Deno.test(pin("registering the same type name twice throws"), () => {
  const env = dynEnvironment().registerType("swamp.Secret", FixtureSecret);
  assertPlainError(
    () => env.registerType("swamp.Secret", FixtureSecret),
    "Invalid type declaration: type 'swamp.Secret' already registered",
  );
});

Deno.test(pin("type names need at least two characters"), () => {
  assertPlainError(
    () => dynEnvironment().registerType("x", FixtureSecret),
    "Invalid type declaration: name 'x' is not valid",
  );
  assertPlainError(
    () => dynEnvironment().registerType("P", { fields: { x: "int" } }),
    "Invalid type declaration: name 'P' is not valid",
  );
  const env = dynEnvironment().registerType("Sx", FixtureSecret);
  assertEquals(
    String(env.evaluate("type(s)", { s: new FixtureSecret("a") })),
    "Type<Sx>",
  );
});

Deno.test(
  pin("built-in and parameterized names cannot be registered as types"),
  () => {
    assertPlainError(
      () => dynEnvironment().registerType("int", FixtureSecret),
      "Invalid type declaration: type 'int' is not valid",
    );
    assertPlainError(
      () => dynEnvironment().registerType("list<Secret>", FixtureSecret),
      "Invalid type declaration: type 'list<Secret>' is not valid",
    );
  },
);

Deno.test(
  pin("a constructor-only registration exposes public own fields"),
  () => {
    const env = dynEnvironment().registerType("Secret", FixtureSecret);
    const s = new FixtureSecret("hunter2");
    assertEquals(env.evaluate("s.v", { s }), "hunter2");
    assertEquals(env.evaluate("has(s.v)", { s }), true);
    assertEquals(env.evaluate("has(s.nope)", { s }), false);
    assertCelError(
      () => env.evaluate("s.nope", { s }),
      EvaluationError,
      "no_such_key",
    );
  },
);

Deno.test(
  pin("declaring a field exposes it even when the value is a secret"),
  () => {
    const env = dynEnvironment().registerType("Secret", {
      ctor: FixtureSecret,
      fields: { v: "string" },
    });
    assertEquals(env.evaluate("s.v", { s: new FixtureSecret("leak") }), "leak");
  },
);

Deno.test(
  pin("fields: {} hides public fields from selection, index, has() and .?"),
  () => {
    const env = dynEnvironment()
      .registerType("Secret", { ctor: FixtureSecret, fields: {} })
      .registerFunction("Secret.reveal(): string", (s: FixtureSecret) => s.v);
    const s = new FixtureSecret("hunter2");
    assertCelError(
      () => env.evaluate("s.v", { s }),
      EvaluationError,
      "no_such_key",
    );
    assertCelError(
      () => env.evaluate("s['v']", { s }),
      EvaluationError,
      "no_such_key",
    );
    assertEquals(env.evaluate("has(s.v)", { s }), false);
    const optional = env.evaluate("s.?v", { s });
    assertInstanceOf(optional, Optional);
    assertEquals(optional.hasValue(), false);
    assertEquals(env.evaluate("s.reveal()", { s }), "hunter2");
  },
);

Deno.test(
  pin("fields: {} with a static variable fails field access at check time"),
  () => {
    const env = dynEnvironment()
      .registerType("Secret", { ctor: FixtureSecret, fields: {} })
      .registerVariable("s", "Secret");
    const result = env.check("s.v");
    assertEquals(result.valid, false);
    assertInstanceOf(result.error, CelTypeError);
    assertEquals(result.error.code, "no_such_key");
    assertCelError(
      () => env.evaluate("s.v", { s: new FixtureSecret("hunter2") }),
      EvaluationError,
      "no_such_key",
    );
  },
);

Deno.test(
  pin(
    "a plain object bound to a statically typed custom variable is a type mismatch",
  ),
  () => {
    const env = dynEnvironment()
      .registerType("Secret", { ctor: FixtureSecret, fields: {} })
      .registerVariable("s", "Secret")
      .registerFunction("Secret.reveal(): string", (s: FixtureSecret) => s.v);
    assertCelError(
      () => env.evaluate("s.reveal()", { s: { v: "p" } }),
      EvaluationError,
      "variable_type_mismatch",
    );
  },
);

Deno.test(
  pin(
    "macros over a dyn custom value with fields: {} still iterate its own enumerable keys",
  ),
  () => {
    const env = dynEnvironment().registerType("Secret", {
      ctor: TwoFieldSecret,
      fields: {},
    });
    const s = new TwoFieldSecret("hunter2");
    assertEquals(env.evaluate("s.map(x, x)", { s }), ["v", "meta"]);
    assertEquals(env.evaluate("s.map(x, true, x)", { s }), ["v", "meta"]);
    assertEquals(env.evaluate("s.filter(x, true)", { s }), ["v", "meta"]);
    assertEquals(env.evaluate("s.all(x, true)", { s }), true);
    assertEquals(env.evaluate("s.exists(x, x == 'v')", { s }), true);
    assertEquals(env.evaluate("s.exists_one(x, true)", { s }), false);
    // The key names leak, but the values stay hidden behind fields: {}.
    assertCelError(
      () => env.evaluate("s.map(x, s[x])", { s }),
      EvaluationError,
      "no_such_key",
    );
  },
);

Deno.test(
  pin(
    "macros over a constructor-only custom value can read every public value",
  ),
  () => {
    const env = dynEnvironment().registerType("Secret", TwoFieldSecret);
    const s = new TwoFieldSecret("hunter2");
    const values = env.evaluate("s.map(x, s[x])", { s }) as unknown[];
    assertEquals(values[0], "hunter2");
    // Nested values come back as the original JS object, not a CEL copy.
    assertStrictEquals(values[1], s.meta);
  },
);

Deno.test(
  pin(
    "a value whose only state is a private field yields an empty macro range",
  ),
  () => {
    const env = dynEnvironment().registerType("Opaque", PrivateFieldSecret);
    const s = new PrivateFieldSecret("hunter2");
    assertEquals(env.evaluate("s.map(x, x)", { s }), []);
    assertEquals(env.evaluate("s.filter(x, true)", { s }), []);
    assertEquals(env.evaluate("s.all(x, true)", { s }), true);
    assertEquals(env.evaluate("s.exists(x, true)", { s }), false);
    assertEquals(env.evaluate("s.exists_one(x, true)", { s }), false);
    assertEquals(env.evaluate("has(s.v)", { s }), false);
  },
);

Deno.test(
  pin("a statically typed custom variable is not a comprehension range"),
  () => {
    const env = dynEnvironment()
      .registerType("Secret", { ctor: FixtureSecret, fields: {} })
      .registerVariable("s", "Secret");
    const s = new FixtureSecret("hunter2");
    for (
      const expression of [
        "s.map(x, x)",
        "s.filter(x, true)",
        "s.all(x, true)",
        "s.exists(x, true)",
        "s.exists_one(x, true)",
      ]
    ) {
      const result = env.check(expression);
      assertEquals(result.valid, false, expression);
      assertEquals(
        result.error?.code,
        "invalid_comprehension_range",
        expression,
      );
      assertCelError(
        () => env.evaluate(expression, { s }),
        EvaluationError,
        "invalid_comprehension_range",
      );
    }
  },
);

Deno.test(
  pin("size(), membership and indexing do not apply to a custom value"),
  () => {
    const env = dynEnvironment().registerType("Secret", {
      ctor: FixtureSecret,
      fields: {},
    });
    const s = new FixtureSecret("hunter2");
    assertCelError(
      () => env.evaluate("size(s)", { s }),
      EvaluationError,
      "no_matching_overload",
    );
    assertCelError(
      () => env.evaluate("'v' in s", { s }),
      EvaluationError,
      "no_such_overload",
    );
    assertCelError(
      () => env.evaluate("s[0]", { s }),
      EvaluationError,
      "no_such_key",
    );
  },
);

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

// Pins for async equality handlers and async property access
// (design/enablers/typed-secrets.md Section 4.2, fact 1: "Async custom function
// inputs are awaited. Derived `!=`, container `isEqual`, and `listIncludes`
// consume equality-handler returns synchronously, and a rejecting async handler
// can leave unobserved promises. Equality handlers must therefore be
// synchronous. A getter that returns a Promise reaches member access as an
// unsupported value.").
//
// Handlers resolve without timers, so a Promise cel-js discards leaves no
// pending timer behind for the test sanitizers.

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { type Environment, EvaluationError } from "cel-js";
import {
  assertCelError,
  dynEnvironment,
  FixtureSecret,
  pin,
} from "./cel_js_pin_test_helpers.ts";

const s = new FixtureSecret("a");
const t = new FixtureSecret("b");

function equalityEnvironment(
  handler: (a: FixtureSecret, b: FixtureSecret) => unknown,
): { env: Environment; calls: () => number } {
  let calls = 0;
  const env = dynEnvironment()
    .registerType("Secret", { ctor: FixtureSecret, fields: {} })
    .registerOperator(
      "Secret == Secret",
      (a: FixtureSecret, b: FixtureSecret) => {
        calls++;
        return handler(a, b);
      },
    );
  return { env, calls: () => calls };
}

Deno.test(
  pin("a Promise-returning == handler is awaited for a direct s == t"),
  async () => {
    const asyncFn = equalityEnvironment(async () =>
      await Promise.resolve(false)
    );
    const direct = asyncFn.env.evaluate("s == t", { s, t });
    assertInstanceOf(direct, Promise);
    assertEquals(await direct, false);

    const plainFn = equalityEnvironment(() => Promise.resolve(true));
    const result = plainFn.env.evaluate("s == t", { s, t });
    assertInstanceOf(result, Promise);
    assertEquals(await result, true);
    assertEquals(plainFn.calls(), 1);
  },
);

Deno.test(pin("forms that wrap a direct == stay awaited"), async () => {
  const { env } = equalityEnvironment(() => Promise.resolve(false));
  assertEquals(await env.evaluate("!(s == t)", { s, t }), true);
  assertEquals(await env.evaluate("s == t ? 'a' : 'b'", { s, t }), "b");
  assertEquals(await env.evaluate("true && s == t", { s, t }), false);
  assertEquals(await env.evaluate("false || s == t", { s, t }), false);
  assertEquals(await env.evaluate("[t].exists(x, x == s)", { s, t }), false);
  assertEquals(await env.evaluate("[t].filter(x, x == s)", { s, t }), []);
  assertEquals(await env.evaluate("[t].map(x, x == s)", { s, t }), [false]);
});

Deno.test(
  pin(
    "!=, list and map equality and membership consume an async == result synchronously",
  ),
  () => {
    // The handler says "not equal". Each form below calls it once, treats the
    // returned Promise as a truthy "equal", and answers synchronously.
    const { env, calls } = equalityEnvironment(() => Promise.resolve(false));
    const wrong: Array<[string, unknown]> = [
      ["s != t", false],
      ["[s] == [t]", true],
      ["[s] != [t]", false],
      ["{'k': s} == {'k': t}", true],
      ["s in [t]", true],
      ["[s] in [[t]]", true],
      ["[t].exists(x, x != s)", false],
      ["[t].all(x, x != s)", false],
    ];
    for (const [expression, observed] of wrong) {
      const before = calls();
      const result = env.evaluate(expression, { s, t });
      assertEquals(result instanceof Promise, false, expression);
      assertEquals(result, observed, expression);
      assertEquals(calls() - before, 1, expression);
    }
  },
);

Deno.test(
  pin("the same forms are correct with a synchronous == handler"),
  () => {
    const { env } = equalityEnvironment((a, b) => a.v === b.v);
    const correct: Array<[string, unknown]> = [
      ["s != t", true],
      ["[s] == [t]", false],
      ["[s] != [t]", true],
      ["{'k': s} == {'k': t}", false],
      ["s in [t]", false],
      ["[s] in [[t]]", false],
      ["[t].exists(x, x != s)", true],
      ["[t].all(x, x != s)", true],
    ];
    for (const [expression, expected] of correct) {
      assertEquals(env.evaluate(expression, { s, t }), expected, expression);
    }
  },
);

Deno.test(
  pin(
    "a direct s == s calls the handler, but [s] == [s] short-circuits on identity",
  ),
  async () => {
    const { env, calls } = equalityEnvironment(() => Promise.resolve(false));
    assertEquals(await env.evaluate("s == s", { s }), false);
    assertEquals(calls(), 1);
    assertEquals(env.evaluate("[s] == [s]", { s }), true);
    assertEquals(calls(), 1);
  },
);

Deno.test(
  pin(
    "a rejecting == handler rejects s == t but leaks unhandled rejections elsewhere",
  ),
  async () => {
    const { env } = equalityEnvironment(() =>
      Promise.reject(new Error("vault unavailable"))
    );
    // A direct comparison surfaces the handler's own Error through its Promise.
    const direct = env.evaluate("s == t", { s, t });
    assertInstanceOf(direct, Promise);
    const error = await assertRejects(() => direct, Error, "vault unavailable");
    assertEquals(error.constructor, Error);

    let leaked = 0;
    // Count and suppress only this handler's rejections; anything else still
    // reaches the test runner.
    const onRejection = (event: PromiseRejectionEvent) => {
      if ((event.reason as Error)?.message !== "vault unavailable") return;
      event.preventDefault();
      leaked++;
    };
    globalThis.addEventListener("unhandledrejection", onRejection);
    try {
      assertEquals(env.evaluate("s != t", { s, t }), false);
      assertEquals(env.evaluate("[s] == [t]", { s, t }), true);
      assertEquals(env.evaluate("s in [t]", { s, t }), true);
      // Wait for at least 3, then assert exactly 3, so an extra leak fails
      // with its count instead of timing out between polls.
      await waitFor(() => leaked >= 3, "three unobserved handler rejections");
      assertEquals(leaked, 3);
    } finally {
      globalThis.removeEventListener("unhandledrejection", onRejection);
    }
  },
);

class Namespace {
  get prop(): Promise<string> {
    return Promise.resolve("p");
  }
}

function namespaceEnvironment(): { env: Environment; calls: () => number } {
  let calls = 0;
  const env = dynEnvironment()
    .registerType("Namespace", { ctor: Namespace, fields: { prop: "string" } })
    .registerFunction(
      "Namespace.load(string): string",
      async (_n: Namespace, key: string) => {
        calls++;
        return await Promise.resolve(`v:${key}`);
      },
    );
  return { env, calls: () => calls };
}

Deno.test(pin("an async receiver function is awaited"), async () => {
  const { env, calls } = namespaceEnvironment();
  const result = env.evaluate("ns.load('a')", { ns: new Namespace() });
  assertInstanceOf(result, Promise);
  assertEquals(await result, "v:a");
  assertEquals(calls(), 1);
});

Deno.test(
  pin(
    "a getter or map member that returns a Promise is unsupported_type on access",
  ),
  () => {
    const { env } = namespaceEnvironment();
    const ns = new Namespace();
    for (
      const expression of [
        "ns.prop",
        "ns.prop == 'p'",
        "ns.prop.size()",
        "ns.prop + 'x'",
      ]
    ) {
      assertCelError(
        () => env.evaluate(expression, { ns }),
        EvaluationError,
        "unsupported_type",
      );
    }
    const m = { prop: Promise.resolve("q") };
    assertCelError(
      () => env.evaluate("m.prop", { m }),
      EvaluationError,
      "unsupported_type",
    );
  },
);

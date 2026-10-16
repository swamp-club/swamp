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

// Phase 1.2 pins for the fault context (design/enablers/typed-secrets.md
// Section 4.3 item 2, and the Phase 1.2 list in Section 11: "A custom function
// sees, at its start, every fault recorded earlier in the same evaluation,
// across asynchronous evaluation, so the effect gate in Section 4.5 holds.";
// "`{S: 1}`, `m[S]` and `S in m` record a fault through a Proxy trap, so a
// map-key refusal is visible under `||` even though a map literal calls no
// overload."; "A fault recorded in the ambient context survives absorption by
// `||`, `&&`, `exists` and `all`, across asynchronous evaluation.").
//
// Handlers resolve without timers, and the interleaving test is driven by
// gates the test releases, so the sanitizers see no pending ops.
import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { Environment, EvaluationError } from "cel-js";
import { assertCelError, pin } from "./cel_js_pin_test_helpers.ts";
import {
  createSecret,
  type Fault,
  recordedFaults,
  recordFault,
  registerAllowedSet,
  registerSecretRefusals,
  registerSecretType,
  secretEnvironmentOptions,
  SecretRefusedError,
  withFaultContext,
} from "./cel_js_secret_fixture.ts";

const s = createSecret("v/k");

/** The refusing environment plus functions that report what they see. */
function refusingEnvironment(): Environment {
  const env = registerAllowedSet(
    registerSecretType(new Environment(secretEnvironmentOptions())),
  );
  registerSecretRefusals(env);
  const seen = () => BigInt(recordedFaults()?.length ?? -1);
  return env
    .registerFunction("faultsSeen(): int", seen, { async: false })
    .registerFunction("faultsSeenAsync(): int", async () => {
      await Promise.resolve();
      return seen();
    })
    .registerFunction("yes(): bool", async () => {
      await Promise.resolve();
      return true;
    });
}

const EQUALS_STRING: Fault = { operation: "Secret == string" };
const EQUALS_INT: Fault = { operation: "Secret == int" };
const TO_PRIMITIVE: Fault = { operation: "Symbol(Symbol.toPrimitive)" };

Deno.test(
  pin(
    "a custom function sees every fault recorded earlier in the same evaluation, synchronously",
  ),
  () => {
    const env = refusingEnvironment();
    const cases: Array<[string, unknown, Fault[]]> = [
      ["faultsSeen()", 0n, []],
      ["(s == 'x' || true) && faultsSeen() == 1", true, [EQUALS_STRING]],
      ["faultsSeen() == 0 && (s == 'x' || true) && faultsSeen() == 1", true, [
        EQUALS_STRING,
      ]],
      ["(s == 'x' || true) && (s == 1 || true) && faultsSeen() == 2", true, [
        EQUALS_STRING,
        EQUALS_INT,
      ]],
    ];
    for (const [expression, expected, recorded] of cases) {
      withFaultContext((faults) => {
        const result = env.evaluate(expression, { s });
        assertEquals(result instanceof Promise, false, expression);
        assertEquals(result, expected, expression);
        assertEquals(faults, recorded, expression);
      });
    }
  },
);

Deno.test(
  pin(
    "a custom function sees every fault recorded earlier across asynchronous evaluation",
  ),
  async () => {
    const env = refusingEnvironment();
    const cases: Array<[string, unknown, Fault[]]> = [
      ["(s == 'x' || true) && faultsSeenAsync() == 1", true, [EQUALS_STRING]],
      ["yes() && (s == 'x' || true) && faultsSeenAsync() == 1", true, [
        EQUALS_STRING,
      ]],
      ["yes() && (s == 'x' || true) && faultsSeen() == 1", true, [
        EQUALS_STRING,
      ]],
      ["(s == 'x' || yes()) && faultsSeenAsync() == 1", true, [EQUALS_STRING]],
    ];
    for (const [expression, expected, recorded] of cases) {
      await withFaultContext(async (faults) => {
        const pending = env.evaluate(expression, { s });
        assertInstanceOf(pending, Promise);
        assertEquals(await pending, expected, expression);
        assertEquals(faults, recorded, expression);
      });
    }
  },
);

Deno.test(
  pin(
    "a Secret as a map key records a fault through Symbol.toPrimitive, visible under ||",
  ),
  () => {
    const env = refusingEnvironment();
    const m = { a: 1n };
    for (const expression of ["{s: 1}", "m[s]", "s in m", "{s: 1}.size()"]) {
      withFaultContext((faults) => {
        assertThrows(
          () => env.evaluate(expression, { s, m }),
          SecretRefusedError,
          "Secret refuses Symbol(Symbol.toPrimitive)",
          expression,
        );
        assertEquals(faults, [TO_PRIMITIVE], expression);
      });
    }
    const absorbed: Array<[string, unknown]> = [
      ["{s: 1} == {} || true", true],
      ["m[s] == 1 || true", true],
      ["s in m || true", true],
      ["{s: 1} == {} && false", false],
    ];
    for (const [expression, expected] of absorbed) {
      withFaultContext((faults) => {
        assertEquals(env.evaluate(expression, { s, m }), expected, expression);
        assertEquals(faults, [TO_PRIMITIVE], expression);
      });
    }
  },
);

Deno.test(
  pin("a recorded fault survives absorption by ||, && , exists and all"),
  () => {
    const env = refusingEnvironment();
    const cases: Array<[string, unknown, Fault[]]> = [
      ["s == 'x' || true", true, [EQUALS_STRING]],
      ["s == 'x' && false", false, [EQUALS_STRING]],
      ["[1, 2].exists(i, i == 2 || s == 'x')", true, [EQUALS_STRING]],
      // The predicate refuses for both elements; the second is absorbed.
      ["[1, 2].exists(i, s == 'x' || i == 2)", true, [
        EQUALS_STRING,
        EQUALS_STRING,
      ]],
      ["[s, 1].exists(x, x == 1)", true, [EQUALS_INT]],
      ["[s, 2].all(x, x == 1)", false, [EQUALS_INT]],
      ["[1, 3].all(i, i == 1 && s == 'x')", false, [EQUALS_STRING]],
    ];
    for (const [expression, expected, recorded] of cases) {
      withFaultContext((faults) => {
        assertEquals(env.evaluate(expression, { s }), expected, expression);
        assertEquals(faults, recorded, expression);
      });
    }
  },
);

Deno.test(
  pin("a recorded fault survives absorption across asynchronous evaluation"),
  async () => {
    const env = refusingEnvironment();
    const cases: Array<[string, unknown, Fault[]]> = [
      ["s == 'x' || yes()", true, [EQUALS_STRING]],
      ["yes() && (s == 'x' || true)", true, [EQUALS_STRING]],
      ["[1, 2].exists(i, yes() && (i == 2 || s == 'x'))", true, [
        EQUALS_STRING,
      ]],
      ["[s, 2].all(x, yes() && x == 1)", false, [EQUALS_INT]],
    ];
    for (const [expression, expected, recorded] of cases) {
      await withFaultContext(async (faults) => {
        const pending = env.evaluate(expression, { s });
        assertInstanceOf(pending, Promise);
        assertEquals(await pending, expected, expression);
        assertEquals(faults, recorded, expression);
      });
    }
  },
);

Deno.test(
  pin(
    "an unselected branch records nothing, and an unabsorbed refusal rethrows",
  ),
  () => {
    const env = refusingEnvironment();
    for (
      const [expression, expected] of [
        ["true || s == 'x'", true],
        ["false && s == 'x'", false],
        ["true ? 1 : size(s)", 1n],
      ] as Array<[string, unknown]>
    ) {
      withFaultContext((faults) => {
        assertEquals(env.evaluate(expression, { s }), expected, expression);
        assertEquals(faults, [], expression);
      });
    }
    withFaultContext((faults) => {
      assertThrows(
        () => env.evaluate("s == 'x' || false", { s }),
        SecretRefusedError,
        "Secret refuses Secret == string",
      );
      assertEquals(faults, [EQUALS_STRING]);
    });
  },
);

Deno.test(
  pin(
    "interleaved asynchronous evaluations keep separate fault lists",
  ),
  async () => {
    const gates = new Map<bigint, PromiseWithResolvers<void>>();
    const started = new Set<bigint>();
    const env = refusingEnvironment().registerFunction(
      "gate(int): bool",
      async (run: bigint) => {
        let gate = gates.get(run);
        if (gate === undefined) {
          gate = Promise.withResolvers<void>();
          gates.set(run, gate);
        }
        started.add(run);
        await gate.promise;
        return true;
      },
    );
    const start = (expression: string, run: bigint) =>
      withFaultContext(async (faults) => ({
        result: await env.evaluate(expression, { s, run }),
        faults,
      }));
    // Run 0 refuses after its gate; run 1 refuses before its gate; run 2
    // never refuses. Every fault must land in the list of the run that
    // caused it.
    const pending = [
      start("gate(run) && (s == 'x' || true) && faultsSeen() == 1", 0n),
      start("(s == 1 || true) && gate(run) && faultsSeen() == 1", 1n),
      start("gate(run) && faultsSeen() == 0", 2n),
    ];
    await waitFor(
      () => started.size === 3,
      "three runs suspended at their gate",
    );
    for (const run of [2n, 1n, 0n]) gates.get(run)?.resolve();
    const [zero, one, two] = await Promise.all(pending);
    assertEquals(zero, { result: true, faults: [EQUALS_STRING] });
    assertEquals(one, { result: true, faults: [EQUALS_INT] });
    assertEquals(two, { result: true, faults: [] });
  },
);

Deno.test(
  pin(
    "outside a fault context a refusal still throws, but the fault is dropped",
  ),
  () => {
    assertEquals(recordedFaults(), undefined);
    assertEquals(recordFault("nothing listens"), false);
    const env = refusingEnvironment();
    assertThrows(
      () => env.evaluate("s == 'x'", { s }),
      SecretRefusedError,
      "Secret refuses Secret == string",
    );
    assertEquals(env.evaluate("s == 'x' || true", { s }), true);
    assertEquals(env.evaluate("faultsSeen()", {}), -1n);
    withFaultContext((faults) => {
      assertEquals(recordFault("someone listens"), true);
      assertEquals(faults, [{ operation: "someone listens" }]);
    });
    assertCelError(
      () => env.evaluate("nope()", {}),
      EvaluationError,
      "no_matching_overload",
    );
  },
);

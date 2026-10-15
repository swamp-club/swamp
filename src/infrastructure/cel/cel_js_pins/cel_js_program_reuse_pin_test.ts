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

// Pins for parsed-program reuse and registry mutation
// (design/enablers/typed-secrets.md Section 4.2: "Parsed programs contain
// mutable checker/comprehension state. Successful concurrent examples are
// evidence for a test case, not a concurrency contract.").
//
// Concurrency is driven by gates the test releases in reverse start order,
// never by timers, so every run is suspended at the same time before any
// resumes.

import { assertEquals, assertInstanceOf } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { type Environment, EvaluationError } from "cel-js";
import {
  assertCelError,
  assertPlainError,
  dynEnvironment,
  FixtureSecret,
  pin,
} from "./cel_js_pin_test_helpers.ts";

/**
 * Registers `gate(value, run)`, which suspends until the test opens gate
 * `run` and then returns `value + "!"`, and `gateBool(value, run)`, which
 * returns whether `value` starts with "y".
 */
function gatedEnvironment(): {
  env: Environment;
  started: Set<bigint>;
  open: (runs: bigint[]) => void;
} {
  const gates = new Map<bigint, PromiseWithResolvers<void>>();
  const started = new Set<bigint>();
  const gateFor = (run: bigint) => {
    let gate = gates.get(run);
    if (gate === undefined) {
      gate = Promise.withResolvers<void>();
      gates.set(run, gate);
    }
    started.add(run);
    return gate.promise;
  };
  const env = dynEnvironment()
    .registerFunction(
      "gate(string, int): string",
      async (value: string, run: bigint) => {
        await gateFor(run);
        return `${value}!`;
      },
    )
    .registerFunction(
      "gateBool(string, int): bool",
      async (value: string, run: bigint) => {
        await gateFor(run);
        return value.startsWith("y");
      },
    );
  const open = (runs: bigint[]) => {
    for (const run of runs) gates.get(run)?.resolve();
  };
  return { env, started, open };
}

/** Start every run, wait until all are suspended, then release them in reverse. */
async function runSuspendedTogether<T>(
  harness: ReturnType<typeof gatedEnvironment>,
  count: number,
  start: (run: bigint) => Promise<T>,
): Promise<T[]> {
  const runs = Array.from({ length: count }, (_, i) => BigInt(i));
  const pending = runs.map(start);
  await waitFor(
    () => harness.started.size === count,
    `${count} runs suspended at their first gate`,
  );
  harness.open([...runs].reverse());
  return await Promise.all(pending);
}

Deno.test(
  pin("one parsed program is reusable across bindings of different types"),
  () => {
    const program = dynEnvironment().parse("x + y");
    assertEquals(program({ x: 1n, y: 2n }), 3n);
    assertEquals(program({ x: "a", y: "b" }), "ab");
    assertCelError(
      () => program({ x: 1.5, y: 2n }),
      EvaluationError,
      "no_such_overload",
    );
    assertEquals(program.check(), { valid: true, type: "dyn" });
  },
);

Deno.test(
  pin(
    "25 concurrent async evaluations of one program show no interference (evidence, not a contract)",
  ),
  async () => {
    const harness = gatedEnvironment();
    const program = harness.env.parse("items.map(x, gate(x, run))");
    const results = await runSuspendedTogether(
      harness,
      25,
      (run) => program({ items: [`r${run}a`, `r${run}b`, `r${run}c`], run }),
    );
    results.forEach((result, i) => {
      assertEquals(result, [`r${i}a!`, `r${i}b!`, `r${i}c!`]);
    });
  },
);

Deno.test(
  pin(
    "concurrent nested comprehensions over one program stay separate (evidence, not a contract)",
  ),
  async () => {
    const harness = gatedEnvironment();
    const program = harness.env.parse(
      "outer.map(o, inner.map(i, gate(o + i, run)))",
    );
    const results = await runSuspendedTogether(
      harness,
      10,
      (run) =>
        program({ outer: [`o${run}`, `p${run}`], inner: ["1", "2"], run }),
    );
    results.forEach((result, k) => {
      assertEquals(result, [[`o${k}1!`, `o${k}2!`], [`p${k}1!`, `p${k}2!`]]);
    });
  },
);

Deno.test(
  pin(
    "concurrent quantifiers and cel.bind over one program stay separate (evidence, not a contract)",
  ),
  async () => {
    const quantifier = gatedEnvironment();
    const exists = quantifier.env.parse("items.exists(x, gateBool(x, run))");
    const items = [["a", "b", "yes"], ["a", "b"], ["y"]];
    assertEquals(
      await runSuspendedTogether(
        quantifier,
        3,
        (run) => exists({ items: items[Number(run)], run }),
      ),
      [true, false, true],
    );

    const binding = gatedEnvironment();
    const bind = binding.env.parse("cel.bind(v, gate(seed, run), [v, v])");
    const seeds = ["a", "b"];
    assertEquals(
      await runSuspendedTogether(
        binding,
        2,
        (run) => bind({ seed: seeds[Number(run)], run }),
      ),
      [["a!", "a!"], ["b!", "b!"]],
    );
  },
);

Deno.test(
  pin(
    "once a program has gone async, a run that takes no async branch still returns a Promise",
  ),
  async () => {
    const harness = gatedEnvironment();
    const program = harness.env.parse(
      "items.map(x, x == 'slow' ? gate(x, run) : x)",
    );
    const asyncRun = program({ items: ["slow", "b"], run: 0n });
    const syncRun = program({ items: ["c", "e"], run: 1n });
    assertInstanceOf(syncRun, Promise);
    harness.open([0n]);
    assertEquals(await asyncRun, ["slow!", "b"]);
    assertEquals(await syncRun, ["c", "e"]);
  },
);

Deno.test(
  pin("a function registered after parse is visible to the existing program"),
  () => {
    const env = dynEnvironment();
    const program = env.parse("f(1)");
    assertCelError(() => program({}), EvaluationError, "no_matching_overload");
    env.registerFunction("f(int): int", (x: bigint) => x + 1n);
    assertEquals(program({}), 2n);
  },
);

function secretEnvironment(): Environment {
  return dynEnvironment().registerType("Secret", {
    ctor: FixtureSecret,
    fields: {},
  });
}

Deno.test(
  pin(
    "an operator registered after parse is used only if the program has not run yet",
  ),
  () => {
    const s = new FixtureSecret("a");
    const equalsString = (a: FixtureSecret, b: string) => a.v === b;

    const beforeFirstRun = secretEnvironment();
    const fresh = beforeFirstRun.parse("s == 'a'");
    beforeFirstRun.registerOperator("Secret == string: bool", equalsString);
    assertEquals(fresh({ s }), true);

    const afterFirstRun = secretEnvironment();
    const program = afterFirstRun.parse("s == 'a'");
    // No overload yet: identity fallback.
    assertEquals(program({ s }), false);
    afterFirstRun.registerOperator("Secret == string: bool", equalsString);
    // The program keeps the dispatch it resolved on its first run.
    assertEquals(program({ s }), false);
    // A new parse on the same environment sees the overload.
    assertEquals(afterFirstRun.parse("s == 'a'")({ s }), true);
    assertEquals(afterFirstRun.evaluate("s == 'a'", { s }), true);
  },
);

Deno.test(pin("clone() freezes the environment it was cloned from"), () => {
  const base = dynEnvironment();
  const child = base.clone();
  assertPlainError(
    () => base.registerFunction("g(int): int", (x: bigint) => x),
    "Cannot modify frozen registry",
  );
  child.registerFunction("h(int): int", (x: bigint) => x * 10n);
  assertEquals(child.evaluate("h(1)"), 10n);
  assertCelError(
    () => base.evaluate("h(1)"),
    EvaluationError,
    "no_matching_overload",
  );
});

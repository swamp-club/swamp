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

// Phase 1.2 pins for the container rule (design/enablers/typed-secrets.md
// Section 4.3 item 5, and the Phase 1.2 list in Section 11: "The container
// rule in Section 4.3 refuses every case the fact 2 pins answer by identity.
// cel-js reads a record field, a list element and a map value through
// ordinary property access, so a getter records the secret on selection and
// on container traversal. Selecting another field records nothing. Map key
// membership, `has()` and `.?` read the value and record it.").
//
// Map key membership on a plain object reads the value because cel-js tells
// an absent key from an undefined one by reading it, and deep type inference
// reads a container's first entry. The rule therefore records a little more
// than its first draft said, and over-refuses accordingly.
//
// The fixture puts each secret behind an enumerable getter, the way the
// accessor adapter and the boundary conversion will (Section 6.1). A `Map`
// instance cannot carry a getter, so the adapter builds plain objects.
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
} from "@std/assert";
import { type ASTNode, Environment, Optional } from "cel-js";
import { pin } from "./cel_js_pin_test_helpers.ts";
import {
  createSecret,
  type Fault,
  recordingList,
  recordingObject,
  registerAllowedSet,
  registerSecretRefusals,
  registerSecretType,
  secretEnvironmentOptions,
  withFaultContext,
} from "./cel_js_secret_test_helpers.ts";

const s = createSecret("v/k");
const t = createSecret("v/k2");
const reads: string[] = [];
const rec = recordingObject("rec", { password: s, other: "o" }, reads);
const lst = recordingList("lst", [s], reads);
const two = recordingList("two", [s, t], reads);
const mp = recordingObject("mp", { k: s }, reads);
const plain = recordingObject("plain", { k: "v" }, reads);
const m = new Map([["k", s]]);
const context = { rec, lst, two, mp, plain, s, m };

function environment(): Environment {
  const env = registerAllowedSet(
    registerSecretType(new Environment(secretEnvironmentOptions())),
  );
  registerSecretRefusals(env);
  return env;
}

interface Observation {
  readonly result: unknown;
  readonly reads: string[];
  readonly faults: Fault[];
}

/** Evaluate once and report what was read and what was refused. */
function observe(env: Environment, expression: string): Observation {
  reads.length = 0;
  return withFaultContext((faults) => {
    const result = env.evaluate(expression, context);
    return { result, reads: [...reads], faults: [...faults] };
  });
}

/**
 * The static half of the container rule: an `in`, or an `==` or `!=` with no
 * operand that is a scalar literal or `null`. List and map literals are not
 * scalars, so `s in [1]` and `1 in lst` count and `x == 'a'` does not.
 */
function hasContainerComparison(node: ASTNode): boolean {
  const { op, args } = node as { op: string; args: unknown };
  if (op === "in") return true;
  if (
    (op === "==" || op === "!=") && Array.isArray(args) &&
    args.every((arg) => (arg as { op?: string }).op !== "value")
  ) {
    return true;
  }
  const children = Array.isArray(args) ? args : [];
  return children.some((child) =>
    typeof child === "object" && child !== null && "op" in child
      ? hasContainerComparison(child as ASTNode)
      : Array.isArray(child) &&
        child.some((grandchild) =>
          typeof grandchild === "object" && grandchild !== null &&
          "op" in grandchild && hasContainerComparison(grandchild as ASTNode)
        )
  );
}

Deno.test(
  pin("selecting a secret-valued field, element or map value records the read"),
  () => {
    const env = environment();
    const selected: Array<[string, string[]]> = [
      ["rec.password", ["rec.password"]],
      ["lst[0]", ["lst[0]"]],
      ["mp.k", ["mp.k"]],
      ["mp['k']", ["mp.k"]],
      ["mp.?k.orValue('d')", ["mp.k"]],
      ["{'a': rec}.a.password", ["rec.password"]],
    ];
    for (const [expression, expected] of selected) {
      const seen = observe(env, expression);
      assertStrictEquals(seen.result, s, expression);
      assertEquals(seen.reads, expected, expression);
      assertEquals(seen.faults, [], expression);
    }
    // Selecting another field reads that field and nothing else.
    const other = observe(env, "rec.other");
    assertEquals(other, { result: "o", reads: ["rec.other"], faults: [] });
    const optional = observe(env, "rec.?password");
    assertInstanceOf(optional.result, Optional);
    assertStrictEquals(optional.result.value(), s);
    assertEquals(optional.reads, ["rec.password"]);
  },
);

Deno.test(pin("container traversal records the element or value"), () => {
  const env = environment();
  const traversed: Array<[string, unknown, string[]]> = [
    ["lst == [1]", false, ["lst[0]", "lst[0]"]],
    ["[1] == lst", false, ["lst[0]", "lst[0]"]],
    ["lst != [1]", true, ["lst[0]", "lst[0]"]],
    ["1 in lst", false, ["lst[0]", "lst[0]"]],
    ["s in lst", true, ["lst[0]", "lst[0]"]],
    ["lst == [s]", true, ["lst[0]", "lst[0]"]],
    ["lst == two", false, ["lst[0]", "two[0]"]],
    ["size(lst)", 1n, ["lst[0]"]],
    ["lst.map(x, 1)", [1n], ["lst[0]"]],
    ["lst.exists(x, x == null)", false, ["lst[0]"]],
    ["mp == {'k': 1}", false, ["mp.k", "mp.k"]],
    ["mp == {'z': 1}", false, ["mp.k"]],
    ["size(mp)", 1n, ["mp.k"]],
    ["rec == {'other': 'o'}", false, ["rec.password"]],
    ["{'a': rec} == {'a': 1}", false, ["rec.password"]],
    ["mp.map(k, k)", ["k"], []],
    ["[rec].exists(x, x.other == 'o')", true, ["rec.other"]],
  ];
  for (const [expression, expected, expectedReads] of traversed) {
    const seen = observe(env, expression);
    assertEquals(seen.result, expected, expression);
    assertEquals(seen.reads, expectedReads, expression);
    assertEquals(seen.faults, [], expression);
  }
});

Deno.test(
  pin(
    "map key membership and a presence check read the value, for a secret and for anything else",
  ),
  () => {
    const env = environment();
    const cases: Array<[string, unknown, string[]]> = [
      ["'k' in mp", true, ["mp.k", "mp.k"]],
      ["'z' in mp", false, ["mp.k"]],
      ["has(mp.k)", true, ["mp.k"]],
      ["has(rec.password)", true, ["rec.password"]],
      ["has(rec.nope)", false, []],
      ["'k' in plain", true, ["plain.k", "plain.k"]],
      ["has(plain.k)", true, ["plain.k"]],
      ["plain.?k", "v", ["plain.k"]],
    ];
    for (const [expression, expected, expectedReads] of cases) {
      const seen = observe(env, expression);
      const result = seen.result instanceof Optional
        ? seen.result.value()
        : seen.result;
      assertEquals(result, expected, expression);
      assertEquals(seen.reads, expectedReads, expression);
      assertEquals(seen.faults, [], expression);
    }
  },
);

Deno.test(
  pin(
    "every identity case the fact 2 pins answer has a container comparison and a recorded secret",
  ),
  () => {
    const env = environment();
    const identity: Array<[string, unknown]> = [
      ["[rec.password] == [rec.password]", true],
      ["[rec.password] == [s]", true],
      ["rec.password in lst", true],
      ["rec.password in [1, rec.password]", true],
      ["1 in two", false],
      ["lst == two", false],
      ["'x' in lst", false],
      ["rec.password in ['x']", false],
      ["lst == ['x']", false],
      ["{'k': rec.password} == {'k': 'x'}", false],
      ["mp == {'k': 'x'}", false],
      ["rec.password in ['', 'changeme']", false],
    ];
    for (const [expression, expected] of identity) {
      assertEquals(
        hasContainerComparison(env.parse(expression).ast),
        true,
        `${expression} has a container comparison`,
      );
      const seen = observe(env, expression);
      assertEquals(seen.result, expected, expression);
      assert(seen.reads.length > 0, `${expression} records`);
      assertEquals(seen.faults, [], `${expression} calls no handler`);
    }
  },
);

Deno.test(
  pin(
    "the rule's two halves separate the allowed comparisons from the over-refused ones",
  ),
  () => {
    const env = environment();
    // Comparison with null and a scalar literal: no container comparison, so
    // the recorded secret alone refuses nothing.
    const allowed = "rec.password != null && rec.other == 'o'";
    assertEquals(hasContainerComparison(env.parse(allowed).ast), false);
    assertEquals(observe(env, allowed), {
      result: true,
      reads: ["rec.password", "rec.other"],
      faults: [],
    });
    // A container comparison with no secret read: refuses nothing.
    const unrelated = "rec.other in ['o']";
    assertEquals(hasContainerComparison(env.parse(unrelated).ast), true);
    assertEquals(observe(env, unrelated), {
      result: true,
      reads: ["rec.other"],
      faults: [],
    });
    // Both halves hold although the secret never reaches the comparison:
    // the over-refusal Section 4.3 accepts.
    const overRefused = "rec.password != null && rec.other in ['o']";
    assertEquals(hasContainerComparison(env.parse(overRefused).ast), true);
    assertEquals(observe(env, overRefused).reads, [
      "rec.password",
      "rec.other",
    ]);
    // The wider case the key-membership read adds: a presence check on a
    // map whose first entry is a secret records it.
    const presence = "'z' in mp || rec.other in ['o']";
    assertEquals(hasContainerComparison(env.parse(presence).ast), true);
    assertEquals(observe(env, presence).reads, ["mp.k", "rec.other"]);
  },
);

Deno.test(
  pin("a Map instance hands the Secret back with no getter in the way"),
  () => {
    const env = environment();
    const seen = observe(env, "m.k");
    assertEquals(seen.reads, []);
    assertStrictEquals(seen.result, s);
    assertEquals(observe(env, "'k' in m"), {
      result: true,
      reads: [],
      faults: [],
    });
  },
);

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

// CelEvaluator with typed secrets on (design/enablers/typed-secrets.md
// Sections 3.2, 4.1 and 4.3, typed-secrets 3.1). Every refusal the inventory
// yields for the internal environment is driven from the inventory itself,
// so a refusal the inventory gains is exercised without a new case here.

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  InvalidExpressionError,
  SECRET_DESTINATION_REFUSED,
  SECRET_OPERATION_UNSUPPORTED,
  type SecretRefusalCode,
  SecretRefusedError,
} from "../../domain/expressions/errors.ts";
import { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import {
  CelEvaluator,
  createInternalCelEnvironment,
  type EvaluationScope,
} from "./cel_evaluator.ts";
import { SecretRedactor } from "../../domain/secrets/secret_redactor.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import {
  functionRefusalSignatures,
  INTERNAL_FUNCTION_SIGNATURES,
  operatorRefusalSignatures,
  parseSignature,
  secretCapableBuiltins,
  SWAMP_FUNCTION_SIGNATURES,
  SWAMP_NAMESPACE_TYPES,
  TYPED_VAULT_FUNCTION_SIGNATURES,
  TYPED_VAULT_NAMESPACE_TYPES,
} from "./cel_js_secret_refusal_inventory.ts";

import { CelVaultNamespace } from "./cel_vault_namespace.ts";

const evaluator = new CelEvaluator({ typedSecrets: true });

/** One run's bag, two vault references and a data-origin entry. */
function fixture() {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = bag.addSecret({ vaultName: "prod", key: "A" }, "inputs.s");
  const t = bag.addSecret({ vaultName: "prod", key: "B" }, "inputs.t");
  const d = bag.addDataSecret("plaintext-from-data", {
    vaultName: "prod",
    key: "C",
  });
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
    return name === "connected" ? [] : null;
  };
  const context: Record<string, unknown> = {
    s,
    t,
    inputs: {
      s,
      t,
      d,
      plain: "x",
      item: "a",
      a: "b",
      rec: { password: s, other: "o" },
      lst: [s],
      two: [s, t],
      mp: { k: s },
      attrs: { password: s, user: "u" },
      nested: { list: [{ token: s }] },
    },
    data: {
      latest: record("latest"),
      version: record("version"),
      listVersions: record("listVersions"),
      findByTag: record("findByTag"),
      findBySpec: record("findBySpec"),
      query: record("query"),
    },
    file: { contents: record("contents") },
    vaultReceiver: new CelVaultNamespace(
      { vaultName: "prod", key: "A" },
      "test",
    ),
    workers: { connected: record("connected") },
    modelMethod: { method: record("method") },
  };
  return { bag, s, t, d, calls, context };
}

function evaluate(expression: string, f = fixture()): unknown {
  return evaluator.evaluate(expression, f.context, { secretBag: f.bag });
}

function assertRefused(
  expression: string,
  operation: string,
  code: SecretRefusalCode = SECRET_OPERATION_UNSUPPORTED,
  f = fixture(),
): SecretRefusedError {
  const error = assertThrows(
    () => evaluate(expression, f),
    SecretRefusedError,
    undefined,
    expression,
  );
  assertEquals(
    { code: error.code, operation: error.operation },
    { code, operation },
    expression,
  );
  assertEquals(error.expression, expression);
  assertStringIncludes(error.message, expression);
  assertEquals(error.cause, undefined);
  return error;
}

/**
 * `expression` plain, and under `||`, `&&`, `exists` and `all` where the
 * other operand decides the result, so cel-js absorbs the refusal's error.
 * The erroring operand comes first, so nothing short-circuits past it.
 */
function absorbed(expression: string): string[] {
  const probe = `dyn(${expression}) == null`;
  return [
    expression,
    `${probe} || true`,
    `${probe} && false`,
    `[1, 2].exists(x, x == 2 ? true : ${probe})`,
    `[1, 2].all(x, x == 2 ? false : ${probe})`,
  ];
}

/** A CEL value of each type an operator refusal pairs a secret with. */
const OPERAND: Readonly<Record<string, string>> = {
  string: "'x'",
  bool: "true",
  int: "1",
  uint: "1u",
  double: "1.5",
  bytes: "b'x'",
  type: "type(1)",
  list: "[1]",
  map: "{'a': 1}",
  optional: "optional.of(1)",
  "google.protobuf.Timestamp": "timestamp('2020-01-01T00:00:00Z')",
  "google.protobuf.Duration": "duration('1s')",
  CelNamespace: "cel",
  OptionalNamespace: "optional",
  Secret: "t",
  null: "null",
  CelFileNamespace: "file",
  CelDataNamespace: "data",
  CelWorkersNamespace: "workers",
  CelModelNamespace: "model",
  CelVaultNamespace: "vaultReceiver",
};

/** The expressions that reach one operator refusal signature. */
function operatorExpressions(signature: string): string[] {
  const unary = /^([!-])Secret$/.exec(signature);
  if (unary) return [`${unary[1]}s`];
  const [left, op, right] = signature.split(" ");
  const value = (type: string) => type === "Secret" ? "s" : OPERAND[type];
  assert(value(left) && value(right), `no operand for ${signature}`);
  if (op === "==") {
    // `!=` and the mirrored order are derived from the one registration.
    return [
      `s == ${value(right)}`,
      `${value(right)} == s`,
      `s != ${value(right)}`,
      `${value(right)} != s`,
    ];
  }
  return [`${value(left)} ${op} ${value(right)}`];
}

/** A receiver or argument of each type a function refusal declares. */
const ARGUMENT: Readonly<Record<string, string>> = {
  string: "'abc'",
  int: "1",
  dyn: "{}",
  "list<dyn>": "[1]",
  "list<string>": "['a']",
  "google.protobuf.Timestamp": "timestamp('2020-01-01T00:00:00Z')",
  CelDataNamespace: "data",
  CelFileNamespace: "file",
  CelModelNamespace: "model",
  CelVaultNamespace: "vaultReceiver",
};

/** The call that reaches one function refusal, with a second secret too. */
function functionExpression(signature: string): string {
  const parsed = parseSignature(signature);
  let secrets = 0;
  const value = (type: string) => {
    if (type === "Secret") return secrets++ % 2 === 0 ? "s" : "t";
    const argument = ARGUMENT[type];
    assert(argument, `no argument for ${type} in ${signature}`);
    return argument;
  };
  const receiver = parsed.receiverType === null
    ? ""
    : `${value(parsed.receiverType)}.`;
  return `${receiver}${parsed.name}(${parsed.params.map(value).join(", ")})`;
}

/** The function refusals the internal environment registers. */
function internalFunctionRefusals(): string[] {
  const swamp = new Set(SWAMP_FUNCTION_SIGNATURES);
  const builtins = secretCapableBuiltins(createInternalCelEnvironment())
    .map((fn) => fn.signature)
    .filter((signature) => !swamp.has(signature));
  return [
    ...functionRefusalSignatures(builtins),
    ...functionRefusalSignatures(INTERNAL_FUNCTION_SIGNATURES),
    ...functionRefusalSignatures(TYPED_VAULT_FUNCTION_SIGNATURES),
  ];
}

Deno.test("CelEvaluator typed secrets: every operator refusal the inventory yields refuses with its code, absorbed or not", () => {
  const signatures = operatorRefusalSignatures([
    ...SWAMP_NAMESPACE_TYPES,
    ...TYPED_VAULT_NAMESPACE_TYPES,
  ]);
  assertEquals(signatures.length, 388);
  for (const signature of signatures) {
    for (const expression of operatorExpressions(signature)) {
      for (const form of absorbed(expression)) {
        assertRefused(form, signature);
      }
    }
  }
});

Deno.test("CelEvaluator typed secrets: every function refusal the inventory yields refuses with its code, absorbed or not, with two secrets too", () => {
  const signatures = internalFunctionRefusals();
  assertEquals(signatures.length, 97);
  for (const signature of signatures) {
    // The model and method names of model.method are routing arguments
    // (Section 4.5 item 2) and refuse as a destination.
    const code = signature.startsWith("CelModelNamespace.method(")
      ? SECRET_DESTINATION_REFUSED
      : SECRET_OPERATION_UNSUPPORTED;
    for (const form of absorbed(functionExpression(signature))) {
      assertRefused(form, signature, code);
    }
  }
  // Two secrets in one call reach the all-Secret overload.
  assertRefused(
    "data.latest(s, t)",
    "CelDataNamespace.latest(Secret, Secret): dyn",
  );
  assertRefused("s.contains(t)", "Secret.contains(Secret): bool");
  assertRefused("s == t", "Secret == Secret");
});

Deno.test("CelEvaluator typed secrets: the allowed set answers without a refusal", () => {
  const f = fixture();
  const cases: Array<[string, unknown]> = [
    ["s", f.s],
    ["inputs.s", f.s],
    ["s + '/x'", `${f.s}/x`],
    ["'x/' + s", `x/${f.s}`],
    ["s + t", `${f.s}${f.t}`],
    ["'a' + s + 'b' + t + 'c'", `a${f.s}b${f.t}c`],
    ["s == null", false],
    ["null == s", false],
    ["s != null", true],
    ["null != s", true],
    ["has(inputs.rec.password)", true],
    ["inputs.rec.?password", f.s],
    ["inputs.rec.?password.orValue('none')", f.s],
    ["has(s.x)", false],
    ["s.?x.orValue('none')", "none"],
    ["dyn(s)", f.s],
    ["cel.bind(v, s, v)", f.s],
    ["optional.of(s).value()", f.s],
    ["[s][0]", f.s],
    ["{'a': s}.a", f.s],
    ["size([s])", 1],
    ["inputs.d", f.d],
    ["inputs.d + '!'", `${f.d}!`],
  ];
  for (const [expression, expected] of cases) {
    assertEquals(evaluate(expression, f), expected, expression);
  }
  // type(S) names the type and reveals nothing.
  evaluate("type(s)", f);
});

Deno.test("CelEvaluator typed secrets: a macro range over a secret refuses through its trap, absorbed or not", () => {
  for (const form of absorbed("s.all(x, true)")) {
    assertRefused(form, "ownKeys");
  }
  assertRefused("s.map(x, x)", "ownKeys");
});

Deno.test("CelEvaluator typed secrets: a secret in the vary values of a data accessor is refused as a destination, at any depth", () => {
  const cases: Array<[string, string]> = [
    ["data.latest('m', 'd', [s])", "the vary values of data.latest"],
    ["data.latest('m', 'd', ['a', [s]])", "the vary values of data.latest"],
    ["data.latest('m', 'd', [{'k': s}])", "the vary values of data.latest"],
    ["data.latest('m', 'd', inputs.lst)", "the vary values of data.latest"],
    ["data.version('m', 'd', [s], 1)", "the vary values of data.version"],
    [
      "data.listVersions('m', 'd', [s])",
      "the vary values of data.listVersions",
    ],
    [
      "dyn(data.latest('m', 'd', [s])) == null || true",
      "the vary values of data.latest",
    ],
  ];
  for (const [expression, operation] of cases) {
    const f = fixture();
    assertRefused(expression, operation, SECRET_DESTINATION_REFUSED, f);
    assertEquals(f.calls, [], `${expression} reached the accessor`);
  }
  const f = fixture();
  evaluate("data.latest('m', 'd', ['a', inputs.plain])", f);
  assertEquals(f.calls, ["latest"]);
});

Deno.test("CelEvaluator typed secrets: model.method routing names refuse a secret as a destination, before any work", () => {
  for (
    const [expression, operation] of [
      [
        "model.method(s, 'run', {})",
        "CelModelNamespace.method(Secret, string, dyn): dyn",
      ],
      ["model.method('m', s)", "CelModelNamespace.method(string, Secret): dyn"],
      [
        "model.method(s, t, {'p': 1})",
        "CelModelNamespace.method(Secret, Secret, dyn): dyn",
      ],
    ]
  ) {
    const f = fixture();
    assertRefused(expression, operation, SECRET_DESTINATION_REFUSED, f);
    assertEquals(f.calls, [], expression);
  }
});

Deno.test("CelEvaluator typed secrets: the effect gate stops model.method after an absorbed refusal, or after a secret read in an expression with a container comparison", () => {
  const cases: [string, string, SecretRefusalCode][] = [
    // || absorbs the refusal of s == 'x'; the effect must not start.
    [
      "s == 'x' || model.method('m', 'run', {}) == null",
      "Secret == string",
      SECRET_OPERATION_UNSUPPORTED,
    ],
    [
      "[s].exists(x, x == 'x') || model.method('m', 'run', {}) == null",
      "Secret == string",
      SECRET_OPERATION_UNSUPPORTED,
    ],
    // A refused destination absorbed the same way.
    [
      "(data.latest('m', 'd', [s]) == null || true) && model.method('m', 'run', {}) == null",
      "the vary values of data.latest",
      SECRET_DESTINATION_REFUSED,
    ],
    // A secret was read and the expression compares containers: the gate
    // refuses before the delegate runs, with the rule's code.
    [
      "s != null && model.method('m', 'run', {}) == null && inputs.item in ['a']",
      "an effect in an expression with a container comparison that read a secret",
      SECRET_OPERATION_UNSUPPORTED,
    ],
    [
      "model.method('m', 'run', {'p': s}) == null && inputs.a == inputs.item",
      "an effect in an expression with a container comparison that read a secret",
      SECRET_OPERATION_UNSUPPORTED,
    ],
  ];
  for (const [expression, operation, code] of cases) {
    const f = fixture();
    assertRefused(expression, operation, code, f);
    assertEquals(f.calls, [], expression);
  }
  // With no secret read, a container comparison beside the effect is fine.
  const f = fixture();
  evaluate("model.method('m', 'run', {}) == null && inputs.item in ['a']", f);
  assertEquals(f.calls, ["method"]);
});

Deno.test("CelEvaluator typed secrets: model.method delivers its inputs through the boundary as a plain sentinel-bearing copy", () => {
  const f = fixture();
  let received: unknown;
  f.context.modelMethod = {
    method: (_m: string, _n: string, inputs: unknown) => {
      received = inputs;
      return null;
    },
  };
  evaluate(
    "model.method('m', 'run', {'p': s, 'q': inputs.nested, 'r': [optional.of(t)], 'n': 1, 'c': s + '-x'})",
    f,
  );
  const inputs = received as Record<string, unknown>;
  // Each Secret left as the sentinel of the run's bag, ints stayed bigints,
  // and nothing is a view or a Secret.
  assertEquals(inputs.p, f.s);
  assertEquals(inputs.q, { list: [{ token: f.s }] });
  assertEquals(inputs.n, 1n);
  assertEquals(inputs.c, `${f.s}-x`);
  const r = inputs.r as Array<{ value(): unknown }>;
  assertEquals(r[0].value(), f.t);
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      assertEquals(
        Object.getOwnPropertyDescriptor(value, key)?.get,
        undefined,
        key,
      );
      walk((value as Record<string, unknown>)[key]);
    }
  };
  walk(inputs);
  assertEquals(f.bag.registry.issuedEntryOf(f.s)?.reference, {
    vaultName: "prod",
    key: "A",
  });
});

Deno.test("CelEvaluator typed secrets: with no run's bag, a secret in model.method inputs is refused as a destination", async () => {
  // Without a bag nothing bound is a Secret; one read from a tagged record is.
  const record = {
    id: "rec-1",
    name: "main",
    version: 1,
    namespace: "",
    modelName: "m",
    tags: { "_swamp.sensitiveFields": JSON.stringify(["password"]) },
    attributes: { password: "${{ vault.get('prod', 'P') }}" },
  };
  const f = fixture();
  f.context.data = {
    ...(f.context.data as Record<string, unknown>),
    latest: () => {
      f.calls.push("latest");
      return record;
    },
  };
  const error = await assertRejects(
    () =>
      evaluator.evaluateAsync(
        "model.method('m', 'run', {'p': data.latest('m', 'd').attributes.password})",
        f.context,
      ),
    SecretRefusedError,
  );
  assertEquals(error.code, SECRET_DESTINATION_REFUSED);
  assertEquals(error.operation, "the inputs of model.method");
  assertEquals(f.calls, ["latest"]);
});

Deno.test("CelEvaluator typed secrets: tagged fields of the record model.method returns are Secrets within the expression", async () => {
  const record = {
    id: "rec-1",
    name: "main",
    version: 1,
    namespace: "",
    modelName: "m",
    tags: { "_swamp.sensitiveFields": JSON.stringify(["password"]) },
    attributes: { password: "${{ vault.get('prod', 'P') }}", host: "h" },
  };
  const f = fixture();
  f.context.modelMethod = { method: () => Promise.resolve(record) };
  // A tagged record is authorized after release, so the asynchronous path
  // with the run's vault scope evaluates it (typed-secrets 3.3).
  const scope: EvaluationScope = {
    secretBag: f.bag,
    vault: {
      service: new VaultService(),
      redactor: new SecretRedactor(),
      location: "test",
    },
  };
  const run = (expression: string) =>
    evaluator.evaluateAsync(expression, f.context, scope);
  // The untagged field reads as before, and the tagged one composes.
  assertEquals(await run("model.method('m', 'run').host"), "h");
  const composed = await run("model.method('m', 'run').password + '-x'");
  assertEquals(typeof composed, "string");
  const sentinel = (composed as string).slice(0, -2);
  assertEquals(f.bag.registry.issuedEntryOf(sentinel)?.reference, {
    vaultName: "prod",
    key: "P",
  });
  assertEquals(f.bag.registry.issuedEntryOf(sentinel)?.dataOrigin, true);
  assertEquals(await run("model.method('m', 'run').password == null"), false);
  // Misuse refuses, as data.latest's Secrets do.
  const error = await assertRejects(
    () => run("model.method('m', 'run').password == 'x'"),
    SecretRefusedError,
  );
  assertEquals(error.code, SECRET_OPERATION_UNSUPPORTED);
  assertEquals(error.operation, "Secret == string");
  // A raw result passes through.
  f.context.modelMethod = { method: () => ({ dataHandles: [] }) };
  assertEquals(await run("model.method('m', 'run')"), { dataHandles: [] });
});

Deno.test("CelEvaluator typed secrets: model.method receives plain inputs, never a view", () => {
  const f = fixture();
  let received: unknown;
  f.context.modelMethod = {
    method: (_m: string, _n: string, inputs: unknown) => {
      received = inputs;
      return null;
    },
  };
  evaluate("model.method('m', 'run', {'p': inputs.plain, 'q': [1]})", f);
  // Ints arrive as numbers, so the inputs serialize (swamp-club#3708).
  assertEquals(received, { p: "x", q: [1] });
  for (const key of ["p", "q"]) {
    assertEquals(
      Object.getOwnPropertyDescriptor(received, key)?.get,
      undefined,
      key,
    );
  }
});

const CONTAINER_RULE =
  "a container comparison (in, or == or != with no scalar literal or null operand) in an expression that reads a secret";

Deno.test("CelEvaluator typed secrets: every container comparison cel-js answers by identity is refused when the expression reads a secret", () => {
  // Where two conversions of a secret meet, cel-js compares them through
  // Secret == Secret, which refuses first; where it answers by identity or
  // type, only the container rule sees the secret. Either refuses.
  for (
    const expression of [
      "[inputs.rec.password] == [inputs.rec.password]",
      "[inputs.rec.password] == [s]",
      "inputs.rec.password in inputs.lst",
      "inputs.rec.password in [1, inputs.rec.password]",
      "1 in inputs.two",
      "inputs.lst == inputs.two",
      "'x' in inputs.lst",
      "inputs.rec.password in ['x']",
      "inputs.lst == ['x']",
      "{'k': inputs.rec.password} == {'k': 'x'}",
      "inputs.mp == {'k': 'x'}",
      "inputs.rec.password in ['', 'changeme']",
      "!(inputs.rec.password in ['', 'changeme'])",
      "s in ['x'] || true",
    ]
  ) {
    const error = assertThrows(
      () => evaluate(expression),
      SecretRefusedError,
      undefined,
      expression,
    );
    assertEquals(error.code, SECRET_OPERATION_UNSUPPORTED, expression);
    assert(
      [CONTAINER_RULE, "Secret == Secret"].includes(error.operation),
      `${expression}: ${error.operation}`,
    );
  }
  // One secret, read through the container only: the rule alone refuses.
  for (
    const expression of [
      "'x' in inputs.lst",
      "inputs.rec.password in ['', 'changeme']",
      "{'k': inputs.rec.password} == {'k': 'x'}",
      "!(inputs.rec.password in ['', 'changeme'])",
    ]
  ) {
    assertRefused(expression, CONTAINER_RULE);
  }
});

Deno.test("CelEvaluator typed secrets: the over-refusals of Section 4.3 fail loudly and name the expression", () => {
  for (
    const expression of [
      "s != null && inputs.item in ['a']",
      "s != null && inputs.a == inputs.item",
      "'z' in inputs.attrs && inputs.item in ['a']",
    ]
  ) {
    const error = assertRefused(expression, CONTAINER_RULE);
    assertEquals(error.expression, expression);
  }
});

Deno.test("CelEvaluator typed secrets: a comparison that reads no secret, or a result read after evaluation, is not refused", () => {
  const f = fixture();
  assertEquals(evaluate("inputs.rec.other in ['o']", f), true);
  assertEquals(evaluate("inputs.plain == inputs.item", f), false);
  assertEquals(
    evaluate("inputs.rec.other in ['o'] ? inputs.rec : null", f),
    { password: f.s, other: "o" },
  );
  assertEquals(
    evaluate("inputs.rec.password != null && inputs.plain == 'x'", f),
    true,
  );
});

Deno.test("CelEvaluator typed secrets: failures that record no fault answer as today's sentinel text does", () => {
  const today = new CelEvaluator();
  for (
    const template of [
      "'abc'.substring(S) == 'x' || true",
      "S || true",
      "S ? 1 : 2",
      "[S].all(x, x) || true",
      "[S].exists(x, x) || true",
      "S.a",
      "S[0]",
    ]
  ) {
    const f = fixture();
    const outcome = (run: () => unknown) => {
      try {
        return { value: run() };
      } catch (error) {
        assertInstanceOf(error, InvalidExpressionError, template);
        return { error: true };
      }
    };
    const typed = outcome(() => evaluate(template.replaceAll("S", "s"), f));
    const plain = outcome(() =>
      today.evaluate(template.replaceAll("S", "s"), { s: f.s })
    );
    assertEquals(typed, plain, template);
  }
});

Deno.test("CelEvaluator typed secrets: a lazy getter on the context fires only when the expression reads it", () => {
  const f = fixture();
  let loads = 0;
  f.context.lazy = {
    web: {
      get resource() {
        loads++;
        return { token: f.s };
      },
    },
  };
  assertEquals(evaluate("inputs.plain + '!'", f), "x!");
  assertEquals(loads, 0);
  assertEquals(evaluate("lazy.web.resource.token", f), f.s);
  assertEquals(loads, 1);
});

Deno.test("CelEvaluator typed secrets: a refusal absorbed across an await still fails the evaluation", async () => {
  const f = fixture();
  f.context.data = {
    findByTag: async () => {
      await Promise.resolve();
      return [];
    },
  };
  const expression = "data.findByTag('k', 'v') != null && (s == 'x' || true)";
  const error = await assertRejects(
    () => evaluator.evaluateAsync(expression, f.context, { secretBag: f.bag }),
    SecretRefusedError,
  );
  assertEquals(error.operation, "Secret == string");
  assertEquals(
    await evaluator.evaluateAsync("s + 'z'", f.context, { secretBag: f.bag }),
    `${f.s}z`,
  );
});

Deno.test("CelEvaluator typed secrets: a synchronous refusal beside an async call leaves no rejection unhandled", async () => {
  for (
    const latest of [
      () => Promise.resolve({ id: "r" }),
      () => Promise.resolve(null),
    ]
  ) {
    const f = fixture();
    f.context.data = { latest };
    const error = assertThrows(
      () => evaluate("s == 'x' || data.latest('m', 'd') == null", f),
      SecretRefusedError,
    );
    assertEquals(error.operation, "Secret == string");
    // Let the abandoned Promise settle; the test sanitizer fails the test on
    // an unhandled rejection.
    await Promise.resolve();
  }
  const rejecting = fixture();
  rejecting.context.data = {
    latest: () => Promise.reject(new Error("unavailable")),
  };
  assertThrows(
    () =>
      evaluate(
        "inputs.rec.password != null && data.latest('m', 'd') in ['x']",
        rejecting,
      ),
    SecretRefusedError,
  );
  await Promise.resolve();
});

Deno.test("CelEvaluator typed secrets: synchronous evaluation returns synchronous results", () => {
  const f = fixture();
  for (
    const expression of [
      "1 == 2",
      "'a' + 'b'",
      "s != null && 1 == 1",
      "s + 'x'",
      "size('abc')",
      "1 in [1]",
    ]
  ) {
    const result = evaluate(expression, f);
    assertEquals(result instanceof Promise, false, expression);
  }
});

Deno.test("CelEvaluator typed secrets: with no run's bag, sentinel text stays text", () => {
  const f = fixture();
  assertEquals(evaluator.evaluate("s == 'x'", { s: f.s }), false);
  assertEquals(evaluator.evaluate("s", { s: f.s }), f.s);
});

Deno.test("CelEvaluator: with typed secrets off, a scope changes nothing and sentinel text stays text", () => {
  const f = fixture();
  const off = new CelEvaluator();
  assertEquals(
    off.evaluate("s == 'x'", { s: f.s }, { secretBag: f.bag }),
    false,
  );
  assertEquals(
    off.evaluate("size(s)", { s: f.s }, { secretBag: f.bag }),
    f.s.length,
  );
});

Deno.test("CelEvaluator typed secrets: a parse error keeps today's error", () => {
  assertThrows(() => evaluate("s +"), InvalidExpressionError);
});

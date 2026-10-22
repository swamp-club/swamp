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

import type { NamespaceReader } from "../../domain/data/namespace.ts";
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { Environment } from "cel-js";
import {
  createQueryEnvironment,
  type QueryProgram,
  type QueryView,
  QueryViewRefusal,
} from "../../domain/data/data_query_service.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import {
  SECRET_OPERATION_UNSUPPORTED,
  SECRET_REFERENCE_INVALID,
} from "../../domain/expressions/errors.ts";
import { SENSITIVE_FIELDS_TAG } from "../../domain/models/data_writer.ts";
import { SECRET_TYPE_NAME } from "./cel_js_secret_refusal_inventory.ts";
import { expressionQueryView, queryViewEnvironment } from "./query_view.ts";
import {
  type FaultScope,
  runInFaultScope,
  SecretRefusal,
} from "./secret_fault_context.ts";
import { isSecret, vaultReferenceSecret } from "./secret_value.ts";
import { isAdaptedView } from "./sensitive_record_adapter.ts";

const REF_A = "${{ vault.get('prod', 'A') }}";
const REF_B = "${{ vault.get('prod', 'B') }}";

/** A record as the query service builds it: own namespace, JSON content. */
function record(
  attributes: Record<string, unknown>,
  tags: Record<string, string> = {},
  overrides: Record<string, unknown> = {},
): DataRecord {
  return {
    id: "r1",
    name: "creds-vary-s3cret",
    version: 2,
    isLatest: true,
    createdAt: "2026-10-19T00:00:00.000Z",
    namespace: "",
    attributes,
    tags: { type: "resource", modelName: "db", ...tags },
    modelName: "db",
    modelId: "m1",
    modelType: "test/model",
    specName: "creds",
    dataType: "resource",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    lifecycle: "active",
    ownerType: "model-method",
    streaming: false,
    size: 1,
    content: attributes,
    path: "",
    ownerRef: "",
    workflowRunId: "",
    workflowName: "",
    jobName: "",
    stepName: "",
    source: "",
    ...overrides,
  } as DataRecord;
}

const pathsTag = (...paths: string[]) => ({
  [SENSITIVE_FIELDS_TAG]: JSON.stringify(paths),
});

const tagged = () =>
  record(
    { password: REF_A, user: "u", nested: { token: REF_B, plain: "p" } },
    pathsTag("password", "nested.token"),
  );

const base = createQueryEnvironment();
/** The reader of `namespace`; a solo row is its own unless it reads them. */
function readerOf(
  namespace: string,
  readsSoloNamespace = false,
): NamespaceReader {
  return { namespace, readsSoloNamespace };
}

const view = expressionQueryView(readerOf(""));
const env = view.environment(base);

function program(expression: string, from: Environment = env): QueryProgram {
  return from.parse(expression) as unknown as QueryProgram;
}

/**
 * A row's context as the service builds it: the record below, the aliases
 * beside it, and attributes and content viewed on first read.
 */
function rowContext(
  r: DataRecord,
  on: QueryView = view,
): Record<string, unknown> {
  const ctx = Object.create(r) as Record<string, unknown>;
  ctx["ns"] = r.namespace;
  ctx["behaviorName"] = r.modelName;
  let viewed: DataRecord | undefined;
  const loadViewed = () => viewed ??= on.record(r);
  Object.defineProperties(ctx, {
    attributes: { get: () => loadViewed().attributes },
    content: { get: () => loadViewed().attributes },
  });
  return ctx;
}

function inScope<T>(fn: (scope: FaultScope) => T): T {
  return runInFaultScope(fn);
}

function definedFunctions(from: Environment): string[] {
  return from.getDefinitions().functions.map((fn) => fn.signature).sort();
}

Deno.test("queryViewEnvironment: registers the Secret type and the allowed set on a clone and leaves the base as it is (the exact refusal set is proven by the coverage fitness test)", () => {
  const names = definedFunctions(env);
  assert(names.some((signature) => signature.includes(SECRET_TYPE_NAME)));
  assert(names.includes(`type(${SECRET_TYPE_NAME}): type`));
  assertEquals(
    JSON.stringify(base.getDefinitions()).includes(SECRET_TYPE_NAME),
    false,
  );
  assertEquals(
    definedFunctions(createQueryEnvironment()),
    definedFunctions(base),
  );
});

Deno.test("queryViewEnvironment: is built once per base, and another base gets its own", () => {
  assertStrictEquals(queryViewEnvironment(base), env);
  assertStrictEquals(
    expressionQueryView(readerOf("other")).environment(base),
    env,
  );
  const another = createQueryEnvironment();
  const other = queryViewEnvironment(another);
  assertNotStrictEquals(other, env);
  assertStrictEquals(queryViewEnvironment(another), other);
});

Deno.test("expressionQueryView.predicate: a Secret reaching latestRun, model or behavior on a per-query clone refuses with secret_operation_unsupported, absorbed or not", () => {
  const perQuery = env.clone()
    .registerFunction("latestRun(string): dyn", (w: string) => `run-${w}`)
    .registerFunction("model(string): bool", () => true)
    .registerFunction("behavior(string): bool", () => true);
  const s = vaultReferenceSecret({ vaultName: "v", key: "k" }, "here");
  assertEquals(
    inScope(() =>
      view.predicate("latestRun('wf')", program("latestRun('wf')", perQuery), {
        s,
      })
    ),
    "run-wf",
  );
  for (const call of ["latestRun(s)", "model(s)", "behavior(s)"]) {
    for (
      const expression of [
        call,
        `${call} == true || true`,
        `[1, 2].exists(x, x == 2 ? true : dyn(${call}) == null)`,
      ]
    ) {
      const error = inScope(() =>
        assertThrows(
          () =>
            view.predicate(expression, program(expression, perQuery), { s }),
          QueryViewRefusal,
          undefined,
          expression,
        )
      );
      assertEquals(error.code, SECRET_OPERATION_UNSUPPORTED, expression);
      assertStringStartsWith(error.operation, `${call.split("(")[0]}(Secret)`);
      assertEquals(error.expression, expression);
    }
  }
});

function assertStringStartsWith(actual: string, prefix: string): void {
  assert(actual.startsWith(prefix), `${actual} does not start with ${prefix}`);
}

Deno.test("expressionQueryView.predicate: the operator refusals and the allowed set behave as in the internal environment, and a secret-free predicate answers as before", () => {
  const r = tagged();
  const run = (expression: string) =>
    inScope(() =>
      view.predicate(expression, program(expression), rowContext(r))
    );
  const refused = inScope(() =>
    assertThrows(
      () =>
        view.predicate(
          "attributes.password == 'x'",
          program("attributes.password == 'x'"),
          rowContext(r),
        ),
      QueryViewRefusal,
    )
  );
  assertEquals(refused.code, SECRET_OPERATION_UNSUPPORTED);
  assertEquals(refused.operation, "Secret == string");
  assertEquals(isSecret(run("attributes.password + '-x'")), true);
  assertEquals(run("attributes.password == null"), false);
  assertEquals(run("attributes.password != null"), true);
  assertEquals(run("has(attributes.password)"), true);
  assertEquals(
    run("attributes.user == 'u' && attributes.nested.plain == 'p'"),
    true,
  );
  assertEquals(run("modelName == 'db' && name == 'creds-vary-s3cret'"), true);
  assertEquals(run("size(attributes) == 3"), true);
});

Deno.test("expressionQueryView.record: adapts an own-namespace tagged record, leaves a foreign and an untagged record as stored, and refuses a malformed one naming data.query and no value", () => {
  inScope(() => {
    const viewed = view.record(tagged());
    assertEquals(isSecret(viewed.attributes.password), true);
    assertEquals(
      isSecret((viewed.attributes.nested as Record<string, unknown>).token),
      true,
    );
    assertEquals(viewed.attributes.user, "u");
    assertStrictEquals(viewed.content, viewed.attributes);
    assertEquals(isAdaptedView(viewed), true);

    const foreign = record({ password: REF_A }, pathsTag("password"), {
      namespace: "security",
    });
    assertStrictEquals(view.record(foreign), foreign);
    assertStrictEquals(
      expressionQueryView(readerOf("security")).record(foreign).attributes
        .password ===
        REF_A,
      false,
    );
    const untagged = record({ password: REF_A });
    assertStrictEquals(view.record(untagged), untagged);

    const error = assertThrows(
      () =>
        view.record(record({ password: "plain-s3cret" }, pathsTag("password"))),
      SecretRefusal,
    );
    assertEquals(error.code, SECRET_REFERENCE_INVALID);
    assertStringIncludes(error.operation, "(data.query)");
    assertStringIncludes(error.operation, "model 'db' record r1 version 2");
    assertEquals(error.operation.includes("plain-s3cret"), false);
    assertEquals(error.operation.includes("creds-vary-s3cret"), false);
  });
});

Deno.test("expressionQueryView.record: a record stamped with the solo namespace is a namespaced reader's own, and another namespace's to a reader that reads the solo namespace (swamp-club#3785)", () => {
  inScope(() => {
    const legacy = tagged();
    const viewed = expressionQueryView(readerOf("eng")).record(legacy);
    assertEquals(isSecret(viewed.attributes.password), true);
    assertEquals(isAdaptedView(viewed), true);
    assertStrictEquals(
      expressionQueryView(readerOf("eng", true)).record(legacy),
      legacy,
    );
  });
});

function assertStringIncludes(actual: string, expected: string): void {
  assert(actual.includes(expected), `${actual} does not include ${expected}`);
}

Deno.test("expressionQueryView.predicate: a refusal propagates whether cel-js threw it or absorbed it, with the calling scope recording the fault and nothing else", () => {
  const r = tagged();
  for (
    const expression of [
      "attributes.password == 'x'",
      "attributes.password == 'x' || true",
      "dyn(attributes.password == 'x') == null && false",
      "[1, 2].exists(x, x == 2 ? true : attributes.password == 'x')",
      "size(attributes.password) > 0 || name == 'creds-vary-s3cret'",
    ]
  ) {
    const calling = inScope((scope) => {
      const error = assertThrows(
        () => view.predicate(expression, program(expression), rowContext(r)),
        QueryViewRefusal,
        undefined,
        expression,
      );
      assertEquals(error.code, SECRET_OPERATION_UNSUPPORTED, expression);
      assertEquals(error.expression, expression);
      return scope;
    });
    assertEquals(calling.faults.length, 1, expression);
    assertEquals(calling.secretsRead, 0, expression);
    assertEquals(calling.sensitiveReferences.size, 0, expression);
  }
});

Deno.test("expressionQueryView.predicate: a malformed record refuses with secret_reference_invalid rather than answering, absorbed or not", () => {
  const bad = record({ password: "plain-s3cret" }, pathsTag("password"));
  for (
    const expression of [
      "attributes.user == 'u'",
      "attributes.user == 'u' || true",
      "has(attributes.password) || name == 'creds-vary-s3cret'",
    ]
  ) {
    const error = inScope(() =>
      assertThrows(
        () => view.predicate(expression, program(expression), rowContext(bad)),
        QueryViewRefusal,
        undefined,
        expression,
      )
    );
    assertEquals(error.code, SECRET_REFERENCE_INVALID, expression);
    assertEquals(error.message.includes("plain-s3cret"), false);
  }
});

Deno.test("expressionQueryView.predicate: the container rule refuses a membership test, a list or map equality, or an equality of two non-literals when the row read a secret, and passes them when it did not", () => {
  const r = tagged();
  for (
    const expression of [
      "attributes.password in ['', 'changeme']",
      "'changeme' in [attributes.password]",
      "[attributes.password] == ['x']",
      "{'k': attributes.password} != {'k': 'x'}",
      "modelName == behaviorName && attributes.password != null",
      "has(attributes.password) && name != ns",
      // The rule decides before an unrelated error in the same row.
      "attributes.password in ['x'] || attributes.missing.k == 'x'",
      "[attributes.password] == ['x'] ? true : attributes.missing.k == 'x'",
    ]
  ) {
    const calling = inScope((scope) => {
      const error = assertThrows(
        () => view.predicate(expression, program(expression), rowContext(r)),
        QueryViewRefusal,
        undefined,
        expression,
      );
      assertEquals(error.code, SECRET_OPERATION_UNSUPPORTED, expression);
      assertStringIncludes(
        error.operation,
        "a container comparison (in, or == or != with no scalar literal or " +
          "null operand) in a query predicate that reads a secret",
      );
      return scope;
    });
    assertEquals(calling.faults.length, 1, expression);
    assertEquals(calling.faults[0].code, SECRET_OPERATION_UNSUPPORTED);
  }
  for (
    const expression of [
      "attributes.user in ['u', 'v']",
      "[attributes.user] == ['u']",
      "modelName == behaviorName",
      "name in ['creds-vary-s3cret'] && attributes.nested.plain == 'p'",
    ]
  ) {
    const calling = inScope((scope) => {
      assertEquals(
        view.predicate(expression, program(expression), rowContext(r)),
        true,
        expression,
      );
      return scope;
    });
    assertEquals(calling.faults, [], expression);
  }
});

Deno.test("expressionQueryView.predicate: a row's secret reads and sensitive references stay with the row, so the calling scope records neither", () => {
  const r = tagged();
  const calling = inScope((scope) => {
    assertEquals(
      view.predicate(
        "attributes.password != null && attributes.nested.token != null",
        program(
          "attributes.password != null && attributes.nested.token != null",
        ),
        rowContext(r),
      ),
      true,
    );
    return scope;
  });
  assertEquals(calling.faults, []);
  assertEquals(calling.secretsRead, 0);
  assertEquals(calling.sensitiveReferences.size, 0);
  assertEquals(calling.recording, true);
});

Deno.test("expressionQueryView.predicate: an error that is no refusal propagates as it is, after the fault check", () => {
  const r = tagged();
  const boom = Object.assign(
    (): unknown => {
      throw new Error("boom");
    },
    { ast: program("true").ast },
  ) as QueryProgram;
  const error = inScope(() =>
    assertThrows(() => view.predicate("boom", boom, rowContext(r)), Error)
  );
  assertEquals(error.message, "boom");
  assertEquals(error instanceof QueryViewRefusal, false);
  // The refusal decides when both happened.
  const both = Object.assign(
    (ctx: Record<string, unknown>): unknown => {
      try {
        program("attributes.password == 'x'")(ctx);
      } catch {
        // absorbed by hand
      }
      throw new Error("boom");
    },
    { ast: program("true").ast },
  ) as QueryProgram;
  const refused = inScope(() =>
    assertThrows(
      () => view.predicate("both", both, rowContext(r)),
      QueryViewRefusal,
    )
  );
  assertEquals(refused.operation, "Secret == string");
});

Deno.test("expressionQueryView.predicate and projection: a Promise answered by the program is refused, and a call outside an evaluation fails closed", () => {
  const r = tagged();
  const later = Object.assign((): unknown => Promise.resolve(true), {
    ast: program("true").ast,
  }) as QueryProgram;
  const calling = inScope((scope) => {
    const error = assertThrows(
      () => view.predicate("later()", later, rowContext(r)),
      QueryViewRefusal,
    );
    assertEquals(error.operation, "an asynchronous query predicate");
    const projected = assertThrows(
      () => view.projection("later()", later, rowContext(r)),
      QueryViewRefusal,
    );
    assertEquals(projected.operation, "an asynchronous query projection");
    return scope;
  });
  assertEquals(calling.faults.length, 2);
  const outside = assertThrows(
    () => view.predicate("true", program("true"), rowContext(r)),
    QueryViewRefusal,
  );
  assertEquals(outside.operation, "a query predicate outside an evaluation");
  const outsideProjection = assertThrows(
    () => view.projection("name", program("name"), rowContext(r)),
    QueryViewRefusal,
  );
  assertEquals(
    outsideProjection.operation,
    "a query projection outside an evaluation",
  );
});

Deno.test("expressionQueryView.projection: a Secret and an adapted view return by identity while the rest coerces, and the row's reads and references land in the calling scope", () => {
  const r = tagged();
  const calling = inScope((scope) => {
    const ctx = rowContext(r);
    const secret = view.projection(
      "attributes.password",
      program("attributes.password"),
      ctx,
    );
    assertEquals(isSecret(secret), true);
    assertStrictEquals(
      secret,
      (ctx.attributes as Record<string, unknown>).password,
    );
    const whole = view.projection("attributes", program("attributes"), ctx);
    assertStrictEquals(whole, ctx.attributes);
    assertEquals(isAdaptedView(whole), true);
    const nested = view.projection(
      "attributes.nested",
      program("attributes.nested"),
      ctx,
    );
    assertEquals(isAdaptedView(nested), true);
    assertEquals(isSecret((nested as Record<string, unknown>).token), true);
    const mixed = view.projection(
      "[attributes.password, 1, {'n': 2, 'v': version}]",
      program("[attributes.password, 1, {'n': 2, 'v': version}]"),
      ctx,
    ) as unknown[];
    assertStrictEquals(mixed[0], secret);
    assertEquals(mixed[1], 1);
    assertEquals(mixed[2], { n: 2, v: 2 });
    assertEquals(
      view.projection("attributes.user", program("attributes.user"), ctx),
      "u",
    );
    assertEquals(view.projection("name", program("name"), ctx), r.name);
    return scope;
  });
  assertEquals(calling.faults, []);
  assert(calling.secretsRead > 0);
  assertEquals(
    [...calling.sensitiveReferences.values()].map((ref) => ref.key).sort(),
    ["A", "B"],
  );
});

Deno.test("expressionQueryView.projection: a refusal propagates, absorbed or not, and the container rule applies to the projection against its own reads", () => {
  const r = tagged();
  for (
    const [expression, operation] of [
      ["attributes.password == 'x'", "Secret == string"],
      ["attributes.password == 'x' || true", "Secret == string"],
      ["string(attributes.password)", "string(Secret): string"],
      [
        "attributes.password in ['x']",
        "a container comparison (in, or == or != with no scalar literal or " +
        "null operand) in a query projection that reads a secret",
      ],
      [
        "[attributes.password] == ['x']",
        "a container comparison (in, or == or != with no scalar literal or " +
        "null operand) in a query projection that reads a secret",
      ],
      [
        "attributes.password in ['x'] ? 1 : attributes.missing.k",
        "a container comparison (in, or == or != with no scalar literal or " +
        "null operand) in a query projection that reads a secret",
      ],
    ]
  ) {
    const calling = inScope((scope) => {
      const error = assertThrows(
        () => view.projection(expression, program(expression), rowContext(r)),
        QueryViewRefusal,
        undefined,
        expression,
      );
      assertEquals(error.code, SECRET_OPERATION_UNSUPPORTED, expression);
      assertEquals(error.operation, operation, expression);
      return scope;
    });
    assertEquals(calling.faults.length, 1, expression);
  }
  // A container comparison that reads no secret passes.
  inScope(() => {
    assertEquals(
      view.projection(
        "attributes.user in ['u']",
        program("attributes.user in ['u']"),
        rowContext(r),
      ),
      true,
    );
  });
});

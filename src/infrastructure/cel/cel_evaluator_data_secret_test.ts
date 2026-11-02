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
  MissingModelDataError,
  SECRET_OPERATION_UNSUPPORTED,
  SECRET_REFERENCE_INVALID,
  SecretRefusedError,
} from "../../domain/expressions/errors.ts";
import { attachStepOutputSources } from "../../domain/expressions/step_output_sources.ts";
import { SENSITIVE_FIELDS_TAG } from "../../domain/models/data_writer.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
  type VaultAccessDenial,
  VaultAccessDeniedError,
} from "../../domain/vaults/run_vault_access.ts";
import { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import type { QueryView } from "../../domain/data/data_query_service.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import { CelEvaluator, type EvaluationScope } from "./cel_evaluator.ts";

const REF_A = "${{ vault.get('prod', 'A') }}";
const REF_B = "${{ vault.get('prod', 'B') }}";
const CONTAINER_RULE =
  "a container comparison (in, or == or != with no scalar literal or null operand) in an expression that reads a secret";

const pathsTag = (...paths: string[]) => ({
  [SENSITIVE_FIELDS_TAG]: JSON.stringify(paths),
});

function record(
  name: string,
  attributes: Record<string, unknown>,
  tags: Record<string, string> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `id-${name}`,
    name: `${name}-vary-s3cret`,
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
  };
}

interface Call {
  accessor: string;
  args: unknown[];
}

function fixture() {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const service = new VaultService();
  const redacted: string[] = [];
  const scope: EvaluationScope = {
    secretBag: bag,
    vault: {
      service,
      redactor: { addSecret: (value) => redacted.push(value) },
      location: "inputs.cmd",
    },
  };
  const records: Record<string, unknown> = {
    main: record("main", {
      password: REF_A,
      user: "u",
      nested: { token: REF_B, plain: "p" },
    }, pathsTag("password", "nested.token")),
    first: record(
      "first",
      { password: REF_A, user: "u" },
      pathsTag("password"),
    ),
    bad: record("bad", { password: "plain-s3cret" }, pathsTag("password")),
    foreign: record("foreign", { password: REF_A }, pathsTag("password"), {
      namespace: "security",
    }),
    untagged: record("untagged", { a: REF_A }),
  };
  const calls: Call[] = [];
  const data = {
    namespace: "",
    latest: (model: string, name: string, options?: unknown) => {
      calls.push({ accessor: "latest", args: [model, name, options] });
      return Promise.resolve(records[name] ?? null);
    },
    version: (model: string, name: string, version: number) => {
      calls.push({ accessor: "version", args: [model, name, version] });
      return Promise.resolve(records[name] ?? null);
    },
    findBySpec: (model: string) =>
      Promise.resolve(model === "empty" ? [] : [records.main, records.first]),
    findByTag: (_key: string, value: string) =>
      Promise.resolve(records[value] === undefined ? [] : [records[value]]),
    query: (predicate: string, select?: string, view?: QueryView) => {
      calls.push({ accessor: "query", args: [predicate, select, view] });
      const named = predicate === "none"
        ? []
        : predicate.split(",").map((name) => records[name]);
      if (!select) return Promise.resolve(named);
      return Promise.resolve(named.map((r) => {
        if (select === "name") return (r as { name: string }).name;
        const viewed = view ? view.record(r as DataRecord) : (r as DataRecord);
        return select === "attributes"
          ? viewed.attributes
          : viewed.attributes.password;
      }));
    },
  };
  const modelData = {
    input: { id: "uuid-1", name: "web" },
    resource: {
      creds: { main: records.main, plain: records.untagged },
      broken: { bad: records.bad },
    },
  };
  const context: Record<string, unknown> = {
    data,
    model: { web: modelData, "uuid-1": modelData },
    inputs: { item: "x" },
  };
  const evaluator = new CelEvaluator();
  return {
    evaluator,
    bag,
    service,
    scope,
    context,
    calls,
    records,
    redacted,
    evaluate: (expression: string, s: EvaluationScope = scope) =>
      evaluator.evaluateAsync(expression, context, s),
  };
}

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

const MAIN_LOCATION =
  "data.latest of model 'db' record id-main version 2 (data.latest)";

Deno.test("CelEvaluator data secrets: a tagged field is read as stored and leaves as a value-less data-origin sentinel located by record and field", async () => {
  const f = fixture();
  const result = await f.evaluate(
    "data.latest('db', 'main').attributes.password",
  );
  assert(typeof result === "string");
  assertEquals(f.bag.registry.entryOf(result), {
    sentinel: result,
    reference: { vaultName: "prod", key: "A" },
    encoding: "raw",
    dataOrigin: true,
    location: `${MAIN_LOCATION}, field 'password'`,
  });
  assertEquals(f.calls, [{
    accessor: "latest",
    args: ["db", "main", { sensitiveFields: "stored" }],
  }]);
  assertEquals(f.bag.rawValues, []);
  assertEquals(f.redacted, []);
  assertEquals(result.includes("s3cret"), false);
});

Deno.test("CelEvaluator data secrets: a whole record keeps its structure, with a sentinel at each tagged field and content aliasing attributes", async () => {
  const f = fixture();
  const result = await f.evaluate("data.latest('db', 'main')") as {
    attributes: {
      password: string;
      user: string;
      nested: { token: string; plain: string };
    };
    content: unknown;
    name: string;
  };
  assert(f.bag.registry.issuedEntryOf(result.attributes.password));
  assert(f.bag.registry.issuedEntryOf(result.attributes.nested.token));
  assertEquals(result.attributes.user, "u");
  assertEquals(result.attributes.nested.plain, "p");
  assertEquals(result.content, result.attributes);
  assertEquals(result.name, "main-vary-s3cret");
  structuredClone(result);
  assertEquals(
    Object.getOwnPropertyDescriptor(result.attributes, "password")?.get,
    undefined,
  );
});

Deno.test("CelEvaluator data secrets: data.version, findBySpec and findByTag adapt too, a miss stays null, an untagged record and a foreign record stay as stored", async () => {
  const f = fixture();
  for (
    const expression of [
      "data.version('db', 'main', 2).attributes.password",
      "data.findBySpec('db', 'creds')[0].attributes.password",
      "data.findByTag('name', 'main')[0].attributes.password",
    ]
  ) {
    const result = await f.evaluate(expression);
    assert(typeof result === "string", expression);
    assert(f.bag.registry.issuedEntryOf(result), expression);
  }
  assertEquals(await f.evaluate("data.latest('db', 'missing')"), null);
  // A non-optional select on the missing record is upstream data not
  // produced yet, told apart from an invalid expression by its class.
  const missing = await assertRejects(
    () => f.evaluate("data.latest('db', 'missing').attributes.password"),
    MissingModelDataError,
  );
  assertStringIncludes(missing.message, "found no data record");
  await assertRejects(
    () => f.evaluate("data.latest('db', 'missing')['attributes']"),
    MissingModelDataError,
  );
  await assertRejects(
    () => f.evaluate("data.latest('db', 'main').attributes.nope"),
    InvalidExpressionError,
  );
  // A miss elsewhere in the expression does not excuse a select on something
  // other than the lookup: that is the expression's own failure, whether or
  // not the unrelated record exists.
  for (
    const expression of [
      "[data.latest('db', 'missing'), {}][1].attributes.password",
      "data.latest('db', 'missing').?attributes.orValue({}) == {} " +
      "&& [{}][0].attributes",
    ]
  ) {
    const failure = await assertRejects(
      () => f.evaluate(expression),
      InvalidExpressionError,
      undefined,
      expression,
    );
    assertEquals(failure instanceof MissingModelDataError, false, expression);
  }
  const unscoped = { secretBag: f.bag };
  assertEquals(
    await f.evaluate("data.latest('db', 'untagged').attributes.a", unscoped),
    REF_A,
  );
  assertEquals(
    await f.evaluate(
      "data.latest('db', 'foreign').attributes.password",
      unscoped,
    ),
    REF_A,
  );
});

Deno.test("CelEvaluator data secrets: missing lookup receivers retain their origin through selected containers and branches without another read", async () => {
  const f = fixture();
  f.context.inputs = { index: 1, key: "record", enabled: false };
  const missing = "data.latest('db', 'missing')";
  for (
    const receiver of [
      `[${missing}][0]`,
      `[{}, ${missing}][inputs.index]`,
      `[${missing}][inputs.index - 1]`,
      `{'record': ${missing}}[inputs.key]`,
      `{'record': ${missing}}['re' + 'cord']`,
      `{'record': {}, 'record': ${missing}}.record`,
      `{'record': {}, inputs.key: ${missing}}.record`,
      `{0: ${missing}}[0.0]`,
      `{'0': ${missing}}[0]`,
      `{'0': {}, 0: ${missing}}['0']`,
      `{true: ${missing}}['true']`,
      `{'record': [${missing}]}.record[0]`,
      `(true ? ${missing} : {})`,
      `(inputs.enabled ? {} : ${missing})`,
      `(inputs.enabled == false ? ${missing} : null)`,
      `(!inputs.enabled && size([1, 2]) == 2 ? ${missing} : {})`,
      `(inputs.index > 0 ? ${missing} : {})`,
    ]
  ) {
    const before = f.calls.length;
    await assertRejects(
      () => f.evaluate(`${receiver}.attributes.password`),
      MissingModelDataError,
      undefined,
      receiver,
    );
    assertEquals(f.calls.length, before + 1, receiver);
  }
  for (
    const receiver of [
      `[${missing}, {}][inputs.index]`,
      `[${missing}, null][inputs.index]`,
      `{'unused': ${missing}, 'record': {}}[inputs.key]`,
      `{'record': ${missing}, 'record': {}}.record`,
      `{'record': ${missing}, inputs.key: {}}.record`,
      `{'0': ${missing}, 0: {}}['0']`,
      `{'constructor': ${missing}}.constructor`,
      `[${missing}, (inputs.enabled ? ${missing} : {})][1]`,
      `[${missing}, (inputs.enabled || false ? ${missing} : {})][1]`,
    ]
  ) {
    const before = f.calls.length;
    const failure = await assertRejects(
      () => f.evaluate(`${receiver}.attributes`),
      InvalidExpressionError,
    );
    assertEquals(failure instanceof MissingModelDataError, false, receiver);
    assertEquals(f.calls.length, before + 1, receiver);
  }
});

Deno.test("CelEvaluator data secrets: an index into a set read that found no record is missing upstream data, and only for that call", async () => {
  const f = fixture();
  for (
    const expression of [
      "data.findBySpec('empty', 'creds')[0].attributes.password",
      "data.findByTag('name', 'absent')[0].attributes.password",
      "data.query('none')[0].attributes",
      "data.query('none', 'name')[0]",
      "[data.findBySpec('empty', 'creds')][0][0].attributes",
      "(true ? data.findByTag('name', 'absent') : [])[0]",
    ]
  ) {
    const missing = await assertRejects(
      () => f.evaluate(expression),
      MissingModelDataError,
      undefined,
      expression,
    );
    assertStringIncludes(missing.message, "found no data record", expression);
  }
  for (
    const expression of [
      "data.findBySpec('db', 'creds')[2]",
      "[data.findByTag('name', 'absent'), []][1][0]",
      "size(data.findByTag('name', 'absent')) == 0 " +
      "? data.findByTag('name', 'main')[1] : null",
    ]
  ) {
    const failure = await assertRejects(
      () => f.evaluate(expression),
      InvalidExpressionError,
      undefined,
      expression,
    );
    assertEquals(failure instanceof MissingModelDataError, false, expression);
  }
});

Deno.test("CelEvaluator data secrets: every tagged reference is authorized after evaluation, selected or not, and a denial surfaces as the option-off denial does, once", async () => {
  const f = fixture();
  const denials: VaultAccessDenial[] = [];
  const denying = RunVaultAccess.create({
    allowedVaults: ["other"],
    allowListSource: "deploy",
    onDenied: (denial) => {
      denials.push(denial);
      return Promise.resolve();
    },
  });
  await runWithVaultAccess(denying, async () => {
    const error = await assertRejects(
      () => f.evaluate("data.latest('db', 'main').attributes.user"),
      InvalidExpressionError,
    );
    assertInstanceOf(error.cause, VaultAccessDeniedError);
    assertStringIncludes(error.message, "Reading vault 'prod' is refused");
    assertEquals(denials.length, 1);
    assertEquals(denials[0].vaultName, "prod");
    const cause = error.cause;
    const off = await assertRejects(
      () =>
        new CelEvaluator().evaluateAsync(
          "data.latest('db', 'main').attributes.user",
          { data: { latest: () => Promise.reject(cause) } },
        ),
      InvalidExpressionError,
    );
    assertEquals(off.message, error.message);
    assertInstanceOf(off.cause, VaultAccessDeniedError);
  });
  const allowing = RunVaultAccess.create({ allowedVaults: ["prod"] });
  await runWithVaultAccess(allowing, async () => {
    assertEquals(
      await f.evaluate("data.latest('db', 'main').attributes.user"),
      "u",
    );
  });
});

Deno.test("CelEvaluator data secrets: a grant revoked mid-run fails the next evaluation before its result is used", async () => {
  const f = fixture();
  let allowed = true;
  const access = RunVaultAccess.create({
    policy: {
      principal: "user:tester",
      decide: () => ({
        allowed,
        reason: allowed ? "granted" : "revoked mid-run",
      }),
    },
  });
  await runWithVaultAccess(access, async () => {
    assertEquals(
      await f.evaluate("data.latest('db', 'main').attributes.user"),
      "u",
    );
    allowed = false;
    await assertRejects(
      () => f.evaluate("data.latest('db', 'main').attributes.user"),
      InvalidExpressionError,
      "revoked mid-run",
    );
  });
});

Deno.test("CelEvaluator data secrets: a set read authorizes every returned record's references, even when the expression uses another record", async () => {
  const f = fixture();
  const access = RunVaultAccess.create({
    policy: {
      principal: "user:tester",
      decide: (_vault, _action, _method, key) => ({
        allowed: key !== "B",
        reason: key === "B" ? "key B is withheld" : "granted",
      }),
    },
  });
  await runWithVaultAccess(access, async () => {
    await assertRejects(
      () => f.evaluate("data.findBySpec('db', 'creds')[1].attributes.user"),
      InvalidExpressionError,
      "key B is withheld",
    );
    assertEquals(
      await f.evaluate("data.findByTag('name', 'first')[0].attributes.user"),
      "u",
    );
  });
});

Deno.test("CelEvaluator data secrets: a missing vault scope fails closed, and the synchronous path fails closed naming evaluateAsync", async () => {
  const f = fixture();
  await assertRejects(
    () =>
      f.evaluate("data.latest('db', 'main').attributes.user", {
        secretBag: f.bag,
      }),
    InvalidExpressionError,
    "requires the run's vault check scope",
  );
  assertThrows(
    () =>
      f.evaluator.evaluate(
        "model.web.resource.creds.main.attributes.user",
        f.context,
        f.scope,
      ),
    InvalidExpressionError,
    "requires evaluateAsync",
  );
  assertEquals(
    f.evaluator.evaluate("model.web.input.name", f.context, f.scope),
    "web",
  );
  assertEquals(
    f.evaluator.evaluate(
      "model.web.resource.creds.plain.attributes.a",
      f.context,
      f.scope,
    ),
    REF_A,
  );
  for (
    const expression of [
      "model.web.resource.creds.main",
      "model.web.resource.creds",
      "[model.web.resource.creds]",
    ]
  ) {
    assertThrows(
      () => f.evaluator.evaluate(expression, f.context, f.scope),
      InvalidExpressionError,
      "requires evaluateAsync",
      expression,
    );
    assertEquals(f.bag.registry.isEmpty, true, expression);
  }
  for (
    const expression of [
      "model.web.resource.broken",
      "model.web.resource",
      "model.web",
    ]
  ) {
    const invalid = assertThrows(
      () => f.evaluator.evaluate(expression, f.context, f.scope),
      SecretRefusedError,
      undefined,
      expression,
    );
    assertEquals(invalid.code, SECRET_REFERENCE_INVALID, expression);
    assertEquals(f.bag.registry.isEmpty, true, expression);
  }
});

Deno.test("CelEvaluator data secrets: the synchronous path reads the whole result, so a bound sentinel ahead of an unread record still refuses before release issues anything", () => {
  const f = fixture();
  f.context.inputs = {
    item: "x",
    s: f.bag.addSecret({ vaultName: "prod", key: "A" }, "inputs.s"),
  };
  const issued = () => [...f.bag.registry.all()].length;
  const before = issued();
  for (
    const expression of [
      "[inputs.s, model.web.resource.creds]",
      "{'a': inputs.s, 'b': model.web.resource.creds}",
      "[inputs.s, model.web.resource.?creds]",
      "[[inputs.s], [model.web.resource.creds]]",
    ]
  ) {
    assertThrows(
      () => f.evaluator.evaluate(expression, f.context, f.scope),
      InvalidExpressionError,
      "requires evaluateAsync",
      expression,
    );
    assertEquals(issued(), before, expression);
  }
  const invalid = assertThrows(
    () =>
      f.evaluator.evaluate(
        "[model.web.resource.creds.main, model.web.resource.broken]",
        f.context,
        f.scope,
      ),
    SecretRefusedError,
  );
  assertEquals(invalid.code, SECRET_REFERENCE_INVALID);
  assertEquals(issued(), before);
  const released = f.evaluator.evaluate(
    "[inputs.s, model.web.resource.creds.plain.attributes.a]",
    f.context,
    f.scope,
  ) as unknown[];
  assertEquals(released[1], REF_A);
});

Deno.test("CelEvaluator data secrets: an invalid record refuses with secret_reference_invalid, absorbed or not, naming the record but never the data name or a value", async () => {
  const f = fixture();
  for (const form of absorbed("data.latest('db', 'bad').attributes.user")) {
    const error = await assertRejects(
      () => f.evaluate(form),
      SecretRefusedError,
      undefined,
      form,
    );
    assertEquals(error.code, SECRET_REFERENCE_INVALID, form);
    assertEquals(
      error.operation,
      "an invalid sensitive-field reference in model 'db' record id-bad version 2 (data.latest): field 'password' is not a stored vault reference",
    );
    assertEquals(error.expression, form);
    assertEquals(error.operation.includes("s3cret"), false);
    assertEquals(error.message.includes("plain-s3cret"), false);
    assertEquals(error.cause, undefined);
  }
  // Let every abandoned promise settle; the sanitizer fails the test on an
  // unhandled rejection.
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(f.bag.registry.isEmpty, true);
});

Deno.test("CelEvaluator data secrets: a resource map returned unread is adapted at release, keeping an invalid record's code and authorizing a valid one's references", async () => {
  const f = fixture();
  const error = await assertRejects(
    () => f.evaluate("model.web.resource.broken"),
    SecretRefusedError,
  );
  assertEquals(error.code, SECRET_REFERENCE_INVALID);
  assertStringIncludes(error.operation, "(model.<name>.resource)");

  const denying = RunVaultAccess.create({ allowedVaults: ["other"] });
  await runWithVaultAccess(denying, async () => {
    const denied = await assertRejects(
      () => f.evaluate("model.web.resource.creds"),
      InvalidExpressionError,
    );
    assertInstanceOf(denied.cause, VaultAccessDeniedError);
  });
  const released = await f.evaluate("model.web.resource.creds") as {
    main: { attributes: { password: string; user: string } };
    plain: { attributes: { a: string } };
  };
  assert(f.bag.registry.issuedEntryOf(released.main.attributes.password));
  assertEquals(released.main.attributes.user, "u");
  assertEquals(released.plain.attributes.a, REF_A);
});

Deno.test("CelEvaluator data secrets: has(), optional access and key membership on a tagged first attribute count as reads for the container rule, and a record returned beside an unrelated comparison does not", async () => {
  const f = fixture();
  for (
    const expression of [
      "has(model.web.resource.creds.main.attributes.password) && inputs.item in ['x']",
      "data.latest('db', 'main').attributes.?password.hasValue() && inputs.item in ['x']",
      "'z' in data.latest('db', 'first').attributes && inputs.item in ['x']",
      "data.latest('db', 'main').attributes.password in ['', 'changeme']",
      "model.web.resource.creds.main.attributes.password != null && inputs.item in ['x']",
    ]
  ) {
    const error = await assertRejects(
      () => f.evaluate(expression),
      SecretRefusedError,
      undefined,
      expression,
    );
    assertEquals(error.code, SECRET_OPERATION_UNSUPPORTED, expression);
    assertEquals(error.operation, CONTAINER_RULE, expression);
  }
  const result = await f.evaluate(
    "inputs.item in ['x'] ? data.latest('db', 'main') : null",
  ) as { attributes: { password: string } };
  assert(f.bag.registry.issuedEntryOf(result.attributes.password));
  assertEquals(
    await f.evaluate("data.latest('db', 'main').attributes.user in ['u']"),
    true,
  );
});

Deno.test("CelEvaluator data secrets: a model indexed by name and by id reads one view, model.method results are adapted, and the caller's context is never mutated", async () => {
  const f = fixture();
  Object.freeze(f.context);
  const originalModel = f.context.model;
  const [byName, byId] = await f.evaluate(
    "[model.web.resource.creds.main.attributes.password, model['uuid-1'].resource.creds.main.attributes.password]",
  ) as [string, string];
  assertEquals(byName, byId);
  assert(f.bag.registry.issuedEntryOf(byName));
  assertEquals(f.context.model, originalModel);

  const withMethod = fixture();
  withMethod.context.modelMethod = {
    method: () => Promise.resolve(withMethod.records.main),
  };
  const password = await withMethod.evaluate(
    "model.method('db', 'run').password",
  ) as string;
  const entry = withMethod.bag.registry.issuedEntryOf(password);
  assertEquals(entry?.dataOrigin, true);
  assertEquals(entry && "reference" in entry && entry.reference, {
    vaultName: "prod",
    key: "A",
  });
});

Deno.test("CelEvaluator.prepareSynchronousReads: authorizes the tagged references of the model-map records an expression reads, so the synchronous evaluate accepts them, and fails closed on anything it did not authorize (typed-secrets 4.1)", async () => {
  const f = fixture();
  const name = "${{ model.web.resource.creds.main.attributes.user }}-x";
  const prepared = await f.evaluator.prepareSynchronousReads(
    name,
    f.context,
    f.scope,
  );
  assertEquals(prepared.authorizedReferences?.size, 2);
  assert(prepared.authorizedReferences?.has("prod\u0000A"));
  assert(prepared.authorizedReferences?.has("prod\u0000B"));
  assertEquals(f.scope.authorizedReferences, undefined);
  assertThrows(
    () =>
      f.evaluator.evaluate(
        "model.web.resource.creds.main.attributes.user",
        f.context,
        f.scope,
      ),
    InvalidExpressionError,
    "requires evaluateAsync",
  );
  assertEquals(
    f.evaluator.evaluate(
      "model.web.resource.creds.main.attributes.user",
      f.context,
      prepared,
    ),
    "u",
  );
  const password = f.evaluator.evaluate(
    "model.web.resource.creds.main.attributes.password",
    f.context,
    prepared,
  ) as string;
  assert(f.bag.registry.issuedEntryOf(password));
  const again = await f.evaluator.prepareSynchronousReads(
    "${{ model['uuid-1'].resource.creds.main.attributes.user }}",
    f.context,
    prepared,
  );
  assertEquals(again, prepared);
  // a reference to a model the content never names is not authorized, so the
  // synchronous read still fails closed; authorization is by vault and key
  const other = {
    ...f.context,
    model: {
      ...(f.context.model as object),
      db: {
        resource: {
          creds: {
            main: record(
              "db-main",
              { password: "${{ vault.get('prod', 'C') }}", user: "u" },
              pathsTag("password"),
            ),
          },
        },
      },
    },
  };
  assertThrows(
    () =>
      f.evaluator.evaluate(
        "model.db.resource.creds.main.attributes.user",
        other,
        prepared,
      ),
    InvalidExpressionError,
    "requires evaluateAsync",
  );
  const both = await f.evaluator.prepareSynchronousReads(
    "${{ model.db.resource.creds.main.attributes.user }}",
    other,
    prepared,
  );
  assertEquals(both.authorizedReferences?.size, 3);
  assertEquals(
    f.evaluator.evaluate(
      "model.db.resource.creds.main.attributes.user",
      other,
      both,
    ),
    "u",
  );
  assertEquals(
    await f.evaluator.prepareSynchronousReads(
      "${{ inputs.item }}",
      f.context,
      f.scope,
    ),
    f.scope,
  );
});

Deno.test("CelEvaluator.prepareSynchronousReads: a denied reference is kept and fails the synchronous evaluate that reads its record with the access error before any sentinel is issued, as does a missing vault scope", async () => {
  const f = fixture();
  const name = "${{ model.web.resource.creds.main.attributes.user }}";
  const denying = RunVaultAccess.create({ allowedVaults: ["other"] });
  await runWithVaultAccess(denying, async () => {
    const prepared = await f.evaluator.prepareSynchronousReads(
      name,
      f.context,
      f.scope,
    );
    assertEquals(prepared.authorizedReferences?.size, 0);
    assertEquals(
      [...prepared.deniedReferences?.keys() ?? []].sort(),
      ["prod\u0000A", "prod\u0000B"],
    );
    const denied = assertThrows(
      () =>
        f.evaluator.evaluate(
          "model.web.resource.creds.main.attributes.user",
          f.context,
          prepared,
        ),
      InvalidExpressionError,
    );
    assertInstanceOf(denied.cause, VaultAccessDeniedError);
    assertStringIncludes(denied.message, "Reading vault 'prod' is refused");
    assertEquals(f.evaluator.evaluate("inputs.item", f.context, prepared), "x");
  });
  assertEquals(f.bag.registry.isEmpty, true);
  const unscoped = await f.evaluator.prepareSynchronousReads(name, f.context, {
    secretBag: f.bag,
  });
  assertEquals(unscoped.deniedReferences?.size, 2);
  assertThrows(
    () =>
      f.evaluator.evaluate(
        "model.web.resource.creds.main.attributes.user",
        f.context,
        unscoped,
      ),
    InvalidExpressionError,
    "requires the run's vault check scope",
  );
  const prepared = await f.evaluator.prepareSynchronousReads(
    "${{ model.web.resource.broken.bad.attributes.password }}",
    f.context,
    f.scope,
  );
  assertEquals(prepared.authorizedReferences?.size, 2);
  const refused = assertThrows(
    () =>
      f.evaluator.evaluate(
        "model.web.resource.broken.bad.attributes.password",
        f.context,
        prepared,
      ),
    SecretRefusedError,
  );
  assertEquals(refused.code, SECRET_REFERENCE_INVALID);
});

Deno.test("CelEvaluator.prepareSynchronousReads: a denied record of a named model that the expression never reads does not fail a read of another of its records", async () => {
  const f = fixture();
  const web = f.context.model as Record<string, Record<string, unknown>>;
  const context = {
    ...f.context,
    model: {
      ...web,
      web: {
        ...web.web,
        resource: {
          ...(web.web.resource as object),
          legacy: {
            old: record(
              "old",
              { password: "${{ vault.get('restricted', 'X') }}", user: "o" },
              pathsTag("password"),
            ),
          },
        },
      },
    },
  };
  const access = RunVaultAccess.create({ allowedVaults: ["prod"] });
  await runWithVaultAccess(access, async () => {
    const prepared = await f.evaluator.prepareSynchronousReads(
      "${{ model.web.resource.creds.main.attributes.user }}",
      context,
      f.scope,
    );
    assertEquals(
      [...prepared.authorizedReferences ?? []].sort(),
      ["prod\u0000A", "prod\u0000B"],
    );
    assertEquals([...prepared.deniedReferences?.keys() ?? []], [
      "restricted\u0000X",
    ]);
    assertEquals(
      f.evaluator.evaluate(
        "model.web.resource.creds.main.attributes.user",
        context,
        prepared,
      ),
      "u",
    );
    const denied = assertThrows(
      () =>
        f.evaluator.evaluate(
          "model.web.resource.legacy.old.attributes.user",
          context,
          prepared,
        ),
      InvalidExpressionError,
      "Reading vault 'restricted' is refused",
    );
    assertInstanceOf(denied.cause, VaultAccessDeniedError);
    assertEquals(f.bag.registry.isEmpty, true);
  });
});

Deno.test("CelEvaluator: steps.<name>.outputs reads through the step's sources with typed secrets on, a tagged field leaving as a data-origin sentinel, prepareSynchronousReads authorizes them for the synchronous evaluate, and the option-off path reads the stored text (typed-secrets 4.2)", async () => {
  const f = fixture();
  const seed = attachStepOutputSources(
    { status: "succeeded", outputs: { password: REF_A, user: "u" } },
    [{
      path: [],
      records: [{
        id: "r-seed",
        name: "seed-vary-s3cret",
        version: 1,
        namespace: "",
        modelName: "writer",
        tags: pathsTag("password"),
        attributes: { password: REF_A, user: "u" },
      }],
    }],
  );
  const wait = { status: "succeeded", outputs: { payload: { ok: true } } };
  const context = { ...f.context, steps: { seed, wait } };
  assertEquals(
    await f.evaluator.evaluateAsync(
      "steps.seed.outputs.user",
      context,
      f.scope,
    ),
    "u",
  );
  const password = await f.evaluator.evaluateAsync(
    "steps.seed.outputs.password",
    context,
    f.scope,
  ) as string;
  const entry = f.bag.registry.issuedEntryOf(password);
  assert(entry);
  assertEquals(entry.reference.vaultName, "prod");
  assertEquals(entry.reference.key, "A");
  assertEquals(entry.dataOrigin, true);
  assertEquals(
    await f.evaluator.evaluateAsync(
      "steps.wait.outputs.payload.ok",
      context,
      f.scope,
    ),
    true,
  );
  await assertRejects(
    () =>
      f.evaluator.evaluateAsync(
        "steps.seed.outputs.password == 'x'",
        context,
        f.scope,
      ),
    SecretRefusedError,
  );
  assertEquals(seed.outputs.password, REF_A);
  assertThrows(
    () => f.evaluator.evaluate("steps.seed.outputs.user", context, f.scope),
    InvalidExpressionError,
    "requires evaluateAsync",
  );
  const prepared = await f.evaluator.prepareSynchronousReads(
    "${{ steps.seed.outputs.user }}",
    context,
    f.scope,
  );
  assert(prepared.authorizedReferences?.has("prod\u0000A"));
  assertEquals(
    f.evaluator.evaluate("steps.seed.outputs.user", context, prepared),
    "u",
  );
  const sentinel = f.evaluator.evaluate(
    "steps.seed.outputs.password",
    context,
    prepared,
  ) as string;
  assert(f.bag.registry.issuedEntryOf(sentinel));
  assertEquals(
    await f.evaluator.prepareSynchronousReads(
      "${{ steps[inputs.item].outputs.user }}",
      context,
      f.scope,
    ),
    f.scope,
  );
});

Deno.test("CelEvaluator data secrets: data.query passes the typed environment's view to its delegate, adapts the records it answers for no select or an empty one, and leaves a projection as the view answered it (typed-secrets 4.3)", async () => {
  const f = fixture();
  const whole = await f.evaluate("data.query('main,foreign')") as DataRecord[];
  const call = f.calls.find((c) => c.accessor === "query");
  assert(call !== undefined);
  assertEquals(call.args[1], undefined);
  const view = call.args[2] as QueryView;
  assertEquals(typeof view.predicate, "function");
  const sentinel = whole[0].attributes.password as string;
  const entry = f.bag.registry.issuedEntryOf(sentinel);
  assert(entry !== undefined);
  assertEquals(entry.dataOrigin, true);
  assertEquals(whole[0].attributes.user, "u");
  assertEquals(whole[1].attributes.password, REF_A);
  assertEquals(whole[1].namespace, "security");

  const empty = await f.evaluate("data.query('main', '')") as DataRecord[];
  assertEquals(f.calls.at(-1)?.args[1], "");
  assert(f.bag.registry.issuedEntryOf(empty[0].attributes.password as string));

  const projected = await f.evaluate(
    "data.query('main', 'attributes.password')",
  ) as string[];
  assertEquals(f.bag.registry.issuedEntryOf(projected[0])?.dataOrigin, true);
  const container = await f.evaluate(
    "data.query('main', 'attributes')",
  ) as Record<string, unknown>[];
  assert(f.bag.registry.issuedEntryOf(container[0].password as string));
  assertEquals(container[0].user, "u");
  assertEquals(
    await f.evaluate("data.query('main', 'name')"),
    ["main-vary-s3cret"],
  );
  assertEquals(
    await f.evaluate(
      "data.query('main', 'attributes.password')[0] + '-x' == null",
    ),
    false,
  );
  assertEquals(f.redacted, []);
  assertEquals(f.bag.rawValues, []);
});

Deno.test("CelEvaluator data secrets: the view data.query hands its delegate is bound to the receiver's own namespace, and with typed secrets off no view is passed", async () => {
  const f = fixture();
  const seen: Array<QueryView | undefined> = [];
  const foreign = f.records.foreign as DataRecord;
  const probe = (namespace: string) => ({
    data: {
      namespace,
      query: (_predicate: string, _select?: string, view?: QueryView) => {
        seen.push(view);
        return Promise.resolve([
          view === undefined
            ? foreign.attributes.password
            : (view.record(foreign).attributes.password as unknown) ===
              foreign.attributes.password,
        ]);
      },
    },
  });
  assertEquals(
    await f.evaluator.evaluateAsync(
      "data.query('x', 'y')",
      probe("security"),
      f.scope,
    ),
    [false],
  );
  assertEquals(
    await f.evaluator.evaluateAsync("data.query('x', 'y')", probe(""), f.scope),
    [true],
  );
  assertEquals(seen.length, 2);
  assert(seen.every((view) => view !== undefined));
});

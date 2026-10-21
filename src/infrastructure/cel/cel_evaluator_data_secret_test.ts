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

// CelEvaluator with typed secrets on, reading data records whose tagged
// fields are sensitive (design/enablers/typed-secrets.md Sections 3.4 and
// 6.1, typed-secrets 3.3): the accessors return data-origin Secrets, the
// evaluator authorizes every reference after release, and invalid records
// refuse with a stable code.

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
  SECRET_OPERATION_UNSUPPORTED,
  SECRET_REFERENCE_INVALID,
  SecretRefusedError,
} from "../../domain/expressions/errors.ts";
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
import { CelEvaluator, type EvaluationScope } from "./cel_evaluator.ts";

const REF_A = "${{ vault.get('prod', 'A') }}";
const REF_B = "${{ vault.get('prod', 'B') }}";
const CONTAINER_RULE =
  "a container comparison (in, or == or != with no scalar literal or null operand) in an expression that reads a secret";

const pathsTag = (...paths: string[]) => ({
  [SENSITIVE_FIELDS_TAG]: JSON.stringify(paths),
});

/** A record as the accessors return it; its data name carries a secret-shaped suffix. */
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
    findBySpec: () => Promise.resolve([records.main, records.first]),
    findByTag: (_key: string, value: string) =>
      Promise.resolve(records[value] === undefined ? [] : [records[value]]),
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
  const evaluator = new CelEvaluator({ typedSecrets: true });
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

/** The forms cel-js absorbs an error under, the erroring operand first. */
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
  // Plain data: cloneable, with no getter left.
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
  // No tag: reference-looking text stays text, and nothing needs a scope.
  const unscoped = { secretBag: f.bag };
  assertEquals(
    await f.evaluate("data.latest('db', 'untagged').attributes.a", unscoped),
    REF_A,
  );
  // Another namespace's record is returned as stored, its tag unread.
  assertEquals(
    await f.evaluate(
      "data.latest('db', 'foreign').attributes.password",
      unscoped,
    ),
    REF_A,
  );
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
    // With typed secrets off the read itself is refused, and the evaluation
    // fails the same way.
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
  // Only the main record references key B; the expression reads the first.
  const access = RunVaultAccess.create({
    policy: {
      principal: "user:tester",
      decide: (_vault, _action, key) => ({
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
  // Reads that touch no tagged record stay synchronous.
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
  // A refused synchronous result issues no sentinel: not a whole record,
  // and not a map the expression returned without reading its records.
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
  // An invalid record first read that way keeps its code wherever it sits:
  // the whole result is read, so a valid record before it decides nothing.
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
  // A sentinel the run issued earlier, bound from the context as a Secret
  // that the result holds before the record.
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
  // An invalid record behind a valid one keeps its code.
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
  // A bound sentinel beside an untagged record is not refused.
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
      // has() takes a select chain, so the record comes from the model map.
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

  // model.method answers the record's attributes with its tagged fields as
  // Secrets (typed-secrets 3.5), so the reference leaves as a data-origin
  // sentinel and never as comparable text.
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

Deno.test("CelEvaluator: with typed secrets off, the same reads return the stored reference text, read with the default options, and issue nothing", async () => {
  const f = fixture();
  const off = new CelEvaluator();
  assertEquals(
    await off.evaluateAsync(
      "data.latest('db', 'main').attributes.password",
      f.context,
      f.scope,
    ),
    REF_A,
  );
  assertEquals(f.calls, [{
    accessor: "latest",
    args: ["db", "main", undefined],
  }]);
  assertEquals(
    off.evaluate(
      "model.web.resource.creds.main.attributes.password",
      f.context,
      f.scope,
    ),
    REF_A,
  );
  assertEquals(f.bag.registry.isEmpty, true);
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
  // The original scope is untouched, and still fails closed.
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
  // Under the prepared scope the read is accepted: a plain field reads, a
  // tagged field leaves as a sentinel issued into the bag, and a record the
  // expression returns whole is adapted and released.
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
  // Expressions reading the same model by id share the authorization; a
  // second prepare adds nothing and answers the same scope.
  const again = await f.evaluator.prepareSynchronousReads(
    "${{ model['uuid-1'].resource.creds.main.attributes.user }}",
    f.context,
    prepared,
  );
  assertEquals(again, prepared);
  // A reference of a model the content never names is not authorized:
  // the synchronous read of it still fails closed under the prepared scope.
  // Authorization is by vault and key, so only a reference the named model
  // does not hold tells the two apart.
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
  // An expression that names no model, or typed secrets off, changes nothing.
  assertEquals(
    await f.evaluator.prepareSynchronousReads(
      "${{ inputs.item }}",
      f.context,
      f.scope,
    ),
    f.scope,
  );
  assertEquals(
    await new CelEvaluator().prepareSynchronousReads(name, f.context, f.scope),
    f.scope,
  );
});

Deno.test("CelEvaluator.prepareSynchronousReads: a denied reference fails the prepare with the access error before any sentinel is issued, and a missing vault scope fails closed", async () => {
  const f = fixture();
  const name = "${{ model.web.resource.creds.main.attributes.user }}";
  const denying = RunVaultAccess.create({ allowedVaults: ["other"] });
  await runWithVaultAccess(denying, async () => {
    const denied = await assertRejects(
      () => f.evaluator.prepareSynchronousReads(name, f.context, f.scope),
      InvalidExpressionError,
    );
    assertInstanceOf(denied.cause, VaultAccessDeniedError);
    assertStringIncludes(denied.message, "Reading vault 'prod' is refused");
  });
  assertEquals(f.bag.registry.isEmpty, true);
  await assertRejects(
    () =>
      f.evaluator.prepareSynchronousReads(name, f.context, {
        secretBag: f.bag,
      }),
    InvalidExpressionError,
    "requires the run's vault check scope",
  );
  // A record whose tag does not parse yields nothing to authorize (the
  // model's valid records still do) and is left for the evaluation to
  // refuse with its own code.
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

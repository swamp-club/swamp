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
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { SECRET_REFERENCE_INVALID } from "../../domain/expressions/errors.ts";
import {
  attachStepOutputSources,
  type StepOutputRecord,
  type StepOutputSources,
} from "../../domain/expressions/step_output_sources.ts";
import { SENSITIVE_FIELDS_TAG } from "../../domain/models/data_writer.ts";
import {
  type FaultScope,
  runInFaultScope,
  SecretRefusal,
} from "./secret_fault_context.ts";
import { isSecret, secretParts } from "./secret_value.ts";
import {
  adaptDataRecord,
  adaptDataResult,
  adaptModelMethodResult,
  isAdaptedView,
  modelMapView,
  stepsView,
  synchronousSensitiveReferences,
} from "./sensitive_record_adapter.ts";

const REF_A = "${{ vault.get('prod', 'A') }}";
const REF_B = "${{ vault.get('prod', 'B') }}";
const DATA_NAME = "creds-vary-s3cret-suffix";
const LOCATION = "data.latest of model 'db' record r1 version 2 (data.latest)";

/** A record as the accessors return it, own namespace, JSON content. */
function record(
  attributes: Record<string, unknown>,
  tags: Record<string, string> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "r1",
    name: DATA_NAME,
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

const pathsTag = (...paths: string[]) => ({
  [SENSITIVE_FIELDS_TAG]: JSON.stringify(paths),
});
const starTag = { [SENSITIVE_FIELDS_TAG]: "*" };

/** Adapts `value` in a fault scope and hands back the view and the scope. */
function adapt(
  value: unknown,
  ownNamespace = "",
): { view: Record<string, unknown>; scope: FaultScope } {
  return runInFaultScope((scope) => ({
    view: adaptDataRecord(value, ownNamespace, "data.latest") as Record<
      string,
      unknown
    >,
    scope,
  }));
}

function attributesOf(view: Record<string, unknown>): Record<string, unknown> {
  return view.attributes as Record<string, unknown>;
}

function assertRefusesInvalid(
  value: unknown,
  reason: string,
  ownNamespace = "",
): { error: SecretRefusal; scope: FaultScope } {
  return runInFaultScope((scope) => {
    const error = assertThrows(
      () => adaptDataRecord(value, ownNamespace, "data.latest"),
      SecretRefusal,
      reason,
    );
    assertEquals(error.code, SECRET_REFERENCE_INVALID);
    assertEquals(scope.faults, [{
      operation: error.operation,
      code: SECRET_REFERENCE_INVALID,
    }]);
    assertEquals(
      error.operation.startsWith(
        `an invalid sensitive-field reference in model 'db' record r1 version 2 (data.latest): `,
      ),
      true,
      error.operation,
    );
    // Never the data name, never a value, never the reference text.
    for (const hidden of [DATA_NAME, "prod", "vault.get", "s3cret"]) {
      assertEquals(error.message.includes(hidden), false, error.message);
    }
    return { error, scope };
  });
}

Deno.test("adaptDataRecord: null, a non-record, an untagged record and a record from another namespace pass through unchanged", () => {
  const untagged = record({ a: REF_A });
  const foreign = record({ a: "plain" }, { ...pathsTag("a") }, {
    namespace: "security",
  });
  const foreignMalformed = record({ a: "x" }, {
    [SENSITIVE_FIELDS_TAG]: "not json",
  }, { namespace: "security" });
  const { scope } = runInFaultScope((scope) => {
    assertEquals(adaptDataRecord(null, "", "data.latest"), null);
    assertEquals(adaptDataRecord("x", "", "data.latest"), "x");
    assertEquals(adaptDataRecord({ id: "r" }, "", "data.latest"), { id: "r" });
    assertStrictEquals(adaptDataRecord(untagged, "", "data.latest"), untagged);
    // A foreign record is returned as stored, its tag unread, even when
    // the tag is malformed or names a non-reference.
    assertStrictEquals(adaptDataRecord(foreign, "", "data.latest"), foreign);
    assertStrictEquals(
      adaptDataRecord(foreignMalformed, "infra", "data.latest"),
      foreignMalformed,
    );
    return { scope };
  });
  assertEquals(scope.sensitiveReferences.size, 0);
  assertEquals(scope.faults, []);
  // An own record reached through a namespaced read is adapted.
  const own = record({ a: REF_A }, pathsTag("a"), { namespace: "infra" });
  const { view } = adapt(own, "infra");
  assert(isSecret(attributesOf(view).a));
});

Deno.test("adaptDataRecord: a tagged leaf reads as one cached data-origin Secret located by model, id, version and path, and each read counts while recording", () => {
  const original = record({ password: REF_A, user: "u" }, pathsTag("password"));
  runInFaultScope((scope) => {
    const view = adaptDataRecord(original, "", "data.latest") as Record<
      string,
      unknown
    >;
    assert(view !== original);
    const first = attributesOf(view).password;
    assert(isSecret(first));
    assertEquals(secretParts(first), [{
      reference: { vaultName: "prod", key: "A" },
      dataOrigin: true,
      location: `${LOCATION}, field 'password'`,
    }]);
    assertStrictEquals(attributesOf(view).password, first);
    assertEquals(scope.secretsRead, 2);
    scope.recording = false;
    assertStrictEquals(attributesOf(view).password, first);
    assertEquals(scope.secretsRead, 2);
    assertEquals(attributesOf(view).user, "u");
    assertEquals([...scope.sensitiveReferences.values()], [{
      vaultName: "prod",
      key: "A",
    }]);
    assertEquals(view.name, DATA_NAME);
    assertEquals(
      (secretParts(first)![0] as { location: string }).location.includes(
        DATA_NAME,
      ),
      false,
    );
  });
});

Deno.test("adaptDataRecord: selecting another field records no read, and references are recorded whether or not they are selected", () => {
  runInFaultScope((scope) => {
    const view = adaptDataRecord(
      record(
        { password: REF_A, token: REF_B, user: "u" },
        pathsTag("password", "token"),
      ),
      "",
      "data.latest",
    ) as Record<string, unknown>;
    assertEquals(attributesOf(view).user, "u");
    assertEquals(scope.secretsRead, 0);
    assertEquals([...scope.sensitiveReferences.keys()].sort(), [
      "prod\u0000A",
      "prod\u0000B",
    ]);
  });
});

Deno.test("adaptDataRecord: content and attributes stay one object for a JSON record, and raw content is unchanged otherwise", () => {
  const json = adapt(record({ password: REF_A }, pathsTag("password")));
  assertStrictEquals(json.view.content, json.view.attributes);
  assert(isSecret((json.view.content as Record<string, unknown>).password));

  const raw = adapt(
    record({ password: REF_A }, pathsTag("password"), {
      content: "raw text ${{ vault.get('prod', 'A') }}",
      contentType: "text/plain",
    }),
  );
  assertEquals(raw.view.content, "raw text ${{ vault.get('prod', 'A') }}");
  assert(isSecret(attributesOf(raw.view).password));
});

Deno.test("adaptDataRecord: under the star tag every leaf at any depth must be absent, null or a stored reference, and a container holds only references", () => {
  const { view, scope } = adapt(
    record({ a: REF_A, b: null, c: REF_B }, starTag),
  );
  assert(isSecret(attributesOf(view).a));
  assertEquals(attributesOf(view).b, null);
  assert(isSecret(attributesOf(view).c));
  assertEquals(scope.sensitiveReferences.size, 2);

  // A schema that marks a parent and a child inside it sensitive leaves the
  // child's reference inside a container at the top level.
  const nested = adapt(
    record(
      { config: { token: REF_A, deeper: { key: REF_B } }, n: null },
      starTag,
    ),
  );
  const config = attributesOf(nested.view).config as Record<string, unknown>;
  assert(isSecret(config.token));
  assert(isSecret((config.deeper as Record<string, unknown>).key));
  assertEquals(
    (secretParts(config.token)![0] as { location: string }).location,
    `${LOCATION}, field 'config.token'`,
  );
  assertEquals(nested.scope.sensitiveReferences.size, 2);

  assertRefusesInvalid(
    record({ a: REF_A, d: "plain-s3cret" }, starTag),
    "field 'd' is not a stored vault reference",
  );
  assertRefusesInvalid(
    record({ config: { token: REF_A, plain: "plain-s3cret" } }, starTag),
    "field 'config.plain' is not a stored vault reference",
  );
  assertRefusesInvalid(
    record({ n: 1 }, starTag),
    "field 'n' is not a stored vault reference",
  );
  const unsafe = JSON.parse('{"__proto__": "x"}') as Record<string, unknown>;
  assertRefusesInvalid(
    record(unsafe, starTag),
    "the unsafe field name '__proto__'",
  );
  assertRefusesInvalid(
    record({ config: JSON.parse('{"constructor": "x"}') }, starTag),
    "the unsafe field name 'constructor'",
  );
  // No tagged field with a value: nothing to refuse and nothing recorded.
  const empty = adapt(record({}, starTag));
  assertEquals(empty.scope.sensitiveReferences.size, 0);
});

Deno.test("adaptDataRecord: nested paths view their containers, absent and null stay, and the writer's parent-and-child artifact is accepted in both orders", () => {
  const original = record(
    { credentials: { apiKey: REF_A, gone: null }, n: null, plain: "p" },
    pathsTag("credentials.apiKey", "credentials", "n", "missing.x"),
  );
  const { view, scope } = adapt(original);
  const credentials = attributesOf(view).credentials as Record<string, unknown>;
  assert(credentials !== original.attributes);
  assert(
    credentials !==
      (original.attributes as Record<string, unknown>).credentials,
  );
  assert(isSecret(credentials.apiKey));
  assertEquals(credentials.gone, null);
  assertEquals(attributesOf(view).n, null);
  assertEquals("missing" in attributesOf(view), false);
  assertEquals(attributesOf(view).plain, "p");
  assertEquals(scope.sensitiveReferences.size, 1);

  // Child first: the parent path holds the reference, the child is absent.
  const childFirst = adapt(
    record(
      { credentials: REF_B },
      pathsTag("credentials.apiKey", "credentials"),
    ),
  );
  assert(isSecret(attributesOf(childFirst.view).credentials));

  // A deeper container on the way to a tagged leaf is accepted too.
  const deep = adapt(
    record({ a: { b: { c: REF_A } } }, pathsTag("a", "a.b.c")),
  );
  const b = (attributesOf(deep.view).a as Record<string, unknown>).b as Record<
    string,
    unknown
  >;
  assert(isSecret(b.c));

  // A container at a path that is a prefix of no other tagged path is not
  // what the writer stores.
  assertRefusesInvalid(
    record({ credentials: { apiKey: REF_A } }, pathsTag("credentials")),
    "field 'credentials' is not a stored vault reference",
  );
  // Nor is an untagged leaf inside a container at a tagged path, at any depth.
  assertRefusesInvalid(
    record(
      { credentials: { apiKey: REF_A, other: "plain-s3cret" } },
      pathsTag("credentials.apiKey", "credentials"),
    ),
    "field 'credentials.other' is not a tagged field of a sensitive container",
  );
  assertRefusesInvalid(
    record({ a: { b: { c: REF_A, x: 1 } } }, pathsTag("a", "a.b.c")),
    "field 'a.b.x' is not a tagged field of a sensitive container",
  );
});

Deno.test("adaptDataRecord: with no known namespace every record is adapted, as the model map's are, and with one a record of another namespace stays as stored", () => {
  const theirs = record({ a: REF_A }, pathsTag("a"), { namespace: "infra" });
  runInFaultScope(() => {
    const view = adaptDataRecord(theirs, undefined, "model.<name>.resource");
    assert(view !== theirs);
    assert(isSecret(attributesOf(view as Record<string, unknown>).a));
    assertStrictEquals(adaptDataRecord(theirs, "", "data.latest"), theirs);
  });
  runInFaultScope(() => {
    const view = modelMapView(
      { web: { resource: { creds: { main: theirs } } } },
      undefined,
    ) as Record<string, unknown>;
    const main = ((((view.web as Record<string, unknown>).resource as Record<
      string,
      unknown
    >).creds as Record<string, unknown>).main) as Record<string, unknown>;
    assert(isSecret(attributesOf(main).a));
  });
});

Deno.test("adaptDataRecord: a tagged value that is not absent, null or a stored reference refuses with secret_reference_invalid and no value", () => {
  for (
    const value of [
      "plain-s3cret",
      42,
      true,
      [REF_A],
      { k: REF_A },
      `prefix ${REF_A}`,
      `${REF_A}${REF_B}`,
      '${{ vault.get("prod", "A") }}',
      "${{ env.HOME }}",
    ]
  ) {
    assertRefusesInvalid(
      record({ password: value }, pathsTag("password")),
      "field 'password' is not a stored vault reference",
    );
  }
});

Deno.test("adaptDataRecord: a malformed tag refuses with the reader's reason and never the tag's text", () => {
  const { error } = assertRefusesInvalid(
    record({ password: REF_A }, {
      [SENSITIVE_FIELDS_TAG]: "not json {s3cret}",
    }),
    `The ${SENSITIVE_FIELDS_TAG} tag is invalid: not JSON`,
  );
  assertEquals(error.message.includes("{s3cret}"), false);
  assertRefusesInvalid(
    record({ password: REF_A }, { [SENSITIVE_FIELDS_TAG]: '["__proto__"]' }),
    "the unsafe path segment '__proto__'",
  );
});

Deno.test("adaptDataRecord: the walk reads own properties only, and reference-looking text outside a tagged path stays text", () => {
  const { view, scope } = adapt(
    record({ a: REF_A, b: REF_B, s: "text" }, pathsTag("a", "toString", "s.x")),
  );
  assert(isSecret(attributesOf(view).a));
  assertEquals(attributesOf(view).b, REF_B);
  assertEquals(attributesOf(view).s, "text");
  assertEquals("toString" in attributesOf(view), true);
  assertEquals(Object.hasOwn(attributesOf(view), "toString"), false);
  assertEquals(scope.sensitiveReferences.size, 1);
});

Deno.test("adaptDataRecord: inputs are never mutated and the view keeps the record's shape", () => {
  const attributes = { credentials: { apiKey: REF_A }, list: [1, "x"] };
  const original = record(attributes, pathsTag("credentials.apiKey"));
  const snapshot = structuredClone(original);
  const freeze = (value: unknown): void => {
    if (typeof value === "object" && value !== null) {
      Object.freeze(value);
      for (const item of Object.values(value)) freeze(item);
    }
  };
  freeze(original);
  const { view } = adapt(original);
  assertEquals(original, snapshot);
  assertEquals(Object.keys(view), Object.keys(original));
  assertEquals(Object.getPrototypeOf(view), Object.prototype);
  assertStrictEquals(attributesOf(view).list, attributes.list);
  assertEquals(view.tags, original.tags);
});

Deno.test("adaptDataResult: adapts null, a record, each record of a list, and the value of a Promise, and a rejected adaptation is a handled refusal", async () => {
  await runInFaultScope(async (scope) => {
    assertEquals(adaptDataResult(null, "", "data.findBySpec"), null);
    const one = record({ a: REF_A }, pathsTag("a"));
    const two = record({ b: REF_B }, pathsTag("b"), { id: "r2" });
    const list = adaptDataResult([one, two, null], "", "data.findBySpec") as [
      Record<string, unknown>,
      Record<string, unknown>,
      null,
    ];
    assert(isSecret(attributesOf(list[0]).a));
    assert(isSecret(attributesOf(list[1]).b));
    assertEquals(list[2], null);
    assertEquals(scope.sensitiveReferences.size, 2);

    const resolved = await (adaptDataResult(
      Promise.resolve(one),
      "",
      "data.latest",
    ) as Promise<Record<string, unknown>>);
    assert(isSecret(attributesOf(resolved).a));

    const rejected = adaptDataResult(
      Promise.resolve(record({ a: "plain" }, pathsTag("a"))),
      "",
      "data.latest",
    ) as Promise<unknown>;
    const error = await assertRejects(() => rejected, SecretRefusal);
    assertEquals(error.code, SECRET_REFERENCE_INVALID);
    assertEquals(scope.faults.length, 1);
    // The adaptation itself is left unobserved by this test; the sanitizer
    // fails the test if the rejection were unhandled.
    adaptDataResult(
      Promise.resolve(record({ a: "plain" }, pathsTag("a"))),
      "",
      "data.latest",
    );
    await Promise.resolve();
    await Promise.resolve();
  });
});

Deno.test("recordSensitiveReference: adapting a tagged record outside an evaluation fails closed", () => {
  assertThrows(
    () =>
      adaptDataRecord(record({ a: REF_A }, pathsTag("a")), "", "data.latest"),
    Error,
    "outside an expression evaluation",
  );
});

/** A model map as buildContext builds it: lazy resource and file loaders. */
function modelMap(instances: Record<string, unknown>) {
  let loads = 0;
  const specs = { creds: instances };
  const modelData: Record<string, unknown> = {
    input: { id: "uuid-1", name: "web" },
    definition: { id: "uuid-1", name: "web" },
  };
  Object.defineProperty(modelData, "resource", {
    configurable: true,
    enumerable: true,
    get() {
      loads++;
      Object.defineProperty(this, "resource", {
        value: specs,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      return specs;
    },
  });
  Object.defineProperty(modelData, "file", {
    configurable: true,
    enumerable: true,
    get() {
      loads++;
      return { readme: { main: { path: "/tmp/readme" } } };
    },
  });
  const model = { web: modelData, "uuid-1": modelData };
  return { model, modelData, specs, loads: () => loads };
}

Deno.test("modelMapView: lazy, shared by name and id, adapts each record at first read, and fires the original loaders only when read", () => {
  const main = record({ password: REF_A, user: "u" }, pathsTag("password"));
  const { model, modelData, specs, loads } = modelMap({ main });
  runInFaultScope((scope) => {
    const view = modelMapView(model, "") as Record<string, unknown>;
    assert(view !== model);
    assertStrictEquals(view.web, view["uuid-1"]);
    assertEquals(loads(), 0);
    assertEquals(scope.sensitiveReferences.size, 0);
    const web = view.web as Record<string, unknown>;
    assertStrictEquals(web.input, modelData.input);
    assertEquals(loads(), 0);
    const creds = (web.resource as Record<string, unknown>).creds as Record<
      string,
      unknown
    >;
    assertEquals(loads(), 1);
    assertEquals(scope.sensitiveReferences.size, 0);
    const adapted = creds.main as Record<string, unknown>;
    assert(adapted !== main);
    assert(isSecret(attributesOf(adapted).password));
    assertEquals(scope.sensitiveReferences.size, 1);
    assertEquals(
      (secretParts(attributesOf(adapted).password)![0] as {
        location: string;
      }).location,
      "model.<name>.resource of model 'db' record r1 version 2 (model.<name>.resource), field 'password'",
    );
    assertStrictEquals(creds.main, adapted);
    assertStrictEquals(
      ((view["uuid-1"] as Record<string, unknown>).resource as Record<
        string,
        unknown
      >).creds,
      creds,
    );
    assertEquals(loads(), 1);
    // The original map is untouched, and its loader has settled its value.
    assertStrictEquals(modelData.resource, specs);
    assertStrictEquals(specs.creds.main, main);
    // Other keys pass through, firing their loader only now.
    assertEquals(
      ((web.file as Record<string, unknown>).readme as Record<
        string,
        Record<string, unknown>
      >).main.path,
      "/tmp/readme",
    );
    assertEquals(loads(), 2);
  });
  // Anything that is not a plain map is returned as it is.
  const receiver = new (class {})();
  assertStrictEquals(modelMapView(receiver, ""), receiver);
  assertEquals(modelMapView(undefined, ""), undefined);
});

Deno.test("modelMapView: a record merged into the original map before first read is seen, and an invalid record refuses at first read", () => {
  const main = record({ password: REF_A }, pathsTag("password"));
  const { model, specs } = modelMap({ main });
  runInFaultScope(() => {
    const view = modelMapView(model, "") as Record<string, unknown>;
    // As the resolver's prepare step merges changed items before binding.
    Object.assign(specs.creds, {
      extra: record({ password: REF_B }, pathsTag("password"), { id: "r2" }),
    });
    const creds = ((view.web as Record<string, unknown>).resource as Record<
      string,
      unknown
    >).creds as Record<string, unknown>;
    assert(
      isSecret(attributesOf(creds.extra as Record<string, unknown>).password),
    );
  });
  const { model: invalid } = modelMap({
    bad: record({ password: "plain" }, pathsTag("password")),
  });
  runInFaultScope((scope) => {
    const view = modelMapView(invalid, "") as Record<string, unknown>;
    const creds = ((view.web as Record<string, unknown>).resource as Record<
      string,
      unknown
    >).creds as Record<string, unknown>;
    const error = assertThrows(() => creds.bad, SecretRefusal);
    assertEquals(error.code, SECRET_REFERENCE_INVALID);
    assertEquals(scope.faults.length, 1);
  });
});

Deno.test("adaptModelMethodResult: a record's attributes with tagged fields as Secrets, a raw result as it is", () => {
  const record = {
    id: "rec-1",
    name: "main",
    version: 1,
    namespace: "ns",
    modelName: "m",
    tags: { "_swamp.sensitiveFields": JSON.stringify(["password"]) },
    attributes: { password: "${{ vault.get('v', 'k') }}", host: "h" },
  };
  const attributes = runInFaultScope(() =>
    adaptModelMethodResult(record) as Record<string, unknown>
  );
  assertEquals(attributes.host, "h");
  assertEquals(isSecret(attributes.password), true);
  // The original record is untouched.
  assertEquals(record.attributes.password, "${{ vault.get('v', 'k') }}");
  // An untagged record answers its attributes as stored.
  assertEquals(
    adaptModelMethodResult({ ...record, tags: {} }),
    record.attributes,
  );
  // Anything that is not a record passes through.
  assertEquals(adaptModelMethodResult({ dataHandles: [] }), {
    dataHandles: [],
  });
  assertEquals(adaptModelMethodResult("text"), "text");
  assertEquals(adaptModelMethodResult(null), null);
});

/** A step output source: the stored form of one record a step wrote. */
function source(
  id: string,
  attributes: Record<string, unknown>,
  tags: Record<string, string> = {},
  namespace = "",
): StepOutputRecord {
  return {
    id,
    name: `${id}-vary-s3cret`,
    version: 1,
    namespace,
    modelName: "writer",
    tags: { type: "resource", ...tags },
    attributes,
  };
}

function sourced(
  outputs: Record<string, unknown>,
  sources: StepOutputSources,
): { status: string; outputs: Record<string, unknown> } {
  return attachStepOutputSources({ status: "succeeded", outputs }, sources);
}

const locationOf = (secret: unknown): string =>
  (secretParts(secret)![0] as { location: string }).location;

Deno.test("stepsView: lazy, reads a sourced step's outputs as the adapted merge where a later record wins, records every reference on first read, counts each tagged read, and passes an unsourced step and the originals through", () => {
  const first = source(
    "r1",
    { password: REF_A, user: "u", shared: "first" },
    pathsTag("password"),
  );
  const second = source(
    "r2",
    { token: REF_B, shared: "second" },
    pathsTag("token"),
  );
  const seed = sourced(
    { password: REF_A, user: "u", shared: "second", token: REF_B },
    [{ path: [], records: [first, second] }],
  );
  const wait = { status: "succeeded", outputs: { payload: { ok: true } } };
  const steps = { seed, wait, skipped: { status: "skipped" } };
  runInFaultScope((scope) => {
    const view = stepsView(steps, "") as Record<string, unknown>;
    assert(view !== steps);
    assertEquals(Object.keys(view), ["seed", "wait", "skipped"]);
    assertStrictEquals(view.wait, wait);
    assertStrictEquals(view.skipped, steps.skipped);
    const seedView = view.seed as Record<string, unknown>;
    assert(seedView !== seed);
    assertEquals(seedView.status, "succeeded");
    // Nothing is adapted until the outputs are read; then every record is,
    // selected or not.
    assertEquals(scope.sensitiveReferences.size, 0);
    const outputs = seedView.outputs as Record<string, unknown>;
    assertEquals(scope.sensitiveReferences.size, 2);
    assertStrictEquals(seedView.outputs, outputs);
    assertEquals(Object.keys(outputs).sort(), [
      "password",
      "shared",
      "token",
      "user",
    ]);
    assertEquals(outputs.user, "u");
    assertEquals(outputs.shared, "second");
    const read = scope.secretsRead;
    assert(isSecret(outputs.password));
    assertEquals(scope.secretsRead, read + 1);
    assert(isSecret(outputs.token));
    assertEquals(
      locationOf(outputs.password),
      "steps.seed.outputs of model 'writer' record r1 version 1 (steps.seed.outputs), field 'password'",
    );
    // The context and its flat outputs are untouched.
    assertEquals(seed.outputs.password, REF_A);
    assertEquals(Object.keys(seed), ["status", "outputs"]);
    assertEquals(first.attributes.password, REF_A);
  });
  const receiver = new (class {})();
  assertStrictEquals(stepsView(receiver, ""), receiver);
  assertEquals(stepsView(undefined, ""), undefined);
});

Deno.test("stepsView: a later record wins whether its field is tagged or plain, and a child's records nest under its step name", () => {
  const taggedThenPlain = sourced({}, [{
    path: [],
    records: [
      source("r1", { x: REF_A }, pathsTag("x")),
      source("r2", { x: "plain" }),
    ],
  }]);
  const plainThenTagged = sourced({}, [{
    path: [],
    records: [
      source("r1", { x: "plain" }),
      source("r2", { x: REF_A }, pathsTag("x")),
    ],
  }]);
  const child = sourced({}, [
    {
      path: ["seed"],
      records: [
        source("c1", { password: REF_A, host: "h" }, pathsTag("password")),
      ],
    },
    { path: ["other"], records: [source("c2", { note: "n" })] },
  ]);
  runInFaultScope(() => {
    const view = stepsView(
      { a: taggedThenPlain, b: plainThenTagged, child },
      "",
    ) as Record<string, Record<string, Record<string, unknown>>>;
    assertEquals(view.a.outputs.x, "plain");
    assert(isSecret(view.b.outputs.x));
    const childOutputs = view.child.outputs as Record<
      string,
      Record<string, unknown>
    >;
    assert(isSecret(childOutputs.seed.password));
    assertEquals(childOutputs.seed.host, "h");
    assertEquals(childOutputs.other, { note: "n" });
    assertEquals(
      locationOf(childOutputs.seed.password),
      "steps.child.outputs of model 'writer' record c1 version 1 (steps.child.outputs), field 'password'",
    );
  });
});

Deno.test("stepsView: an invalid source refuses with secret_reference_invalid at first read of the outputs, naming the accessor and never a value, and a record of another namespace stays as stored", () => {
  const invalid = sourced({ password: "plain-s3cret" }, [{
    path: [],
    records: [
      source("bad", { password: "plain-s3cret" }, pathsTag("password")),
    ],
  }]);
  runInFaultScope((scope) => {
    const view = stepsView({ bad: invalid }, "") as Record<
      string,
      Record<string, unknown>
    >;
    const error = assertThrows(() => view.bad.outputs, SecretRefusal);
    assertEquals(error.code, SECRET_REFERENCE_INVALID);
    assertStringIncludes(error.message, "(steps.bad.outputs)");
    assertStringIncludes(error.message, "record bad version 1");
    assertEquals(error.message.includes("plain-s3cret"), false);
    assertEquals(error.message.includes("vary"), false);
    assertEquals(scope.faults.length, 1);
  });
  const foreign = sourced({ password: REF_A }, [{
    path: [],
    records: [
      source("f", { password: REF_A }, pathsTag("password"), "security"),
    ],
  }]);
  runInFaultScope((scope) => {
    const view = stepsView({ f: foreign }, "") as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    assertEquals(view.f.outputs.password, REF_A);
    assertEquals(scope.sensitiveReferences.size, 0);
  });
});

Deno.test("synchronousSensitiveReferences: lists the references of the sources of every step the expression names, beside the model map's, and nothing for a computed key, a step without sources, a foreign record or an absent map (typed-secrets 4.2)", () => {
  const seed = sourced({}, [{
    path: [],
    records: [
      source("r1", { password: REF_A }, pathsTag("password")),
      source("r2", { token: REF_B }, pathsTag("token")),
    ],
  }]);
  const foreign = sourced({}, [{
    path: [],
    records: [
      source("f", { password: REF_A }, pathsTag("password"), "security"),
    ],
  }]);
  const steps = { seed, foreign, wait: { status: "succeeded", outputs: {} } };
  const keys = (
    cel: string,
    namespace: string | undefined = "",
    map: unknown = steps,
    model: unknown = undefined,
  ): string[] =>
    synchronousSensitiveReferences(cel, model, namespace, map)
      .map((r) => `${r.vaultName}/${r.key}`)
      .sort();
  assertEquals(keys("steps.seed.outputs.password"), ["prod/A", "prod/B"]);
  assertEquals(keys("steps['seed'].status"), ["prod/A", "prod/B"]);
  assertEquals(keys("steps.wait.outputs"), []);
  assertEquals(keys("steps[inputs.name].outputs"), []);
  assertEquals(keys("steps.foreign.outputs.password"), []);
  // With no namespace to name the reader's own, every record is the run's.
  assertEquals(
    synchronousSensitiveReferences(
      "steps.foreign.outputs.password",
      undefined,
      undefined,
      steps,
    ).map((r) => `${r.vaultName}/${r.key}`),
    ["prod/A"],
  );
  assertEquals(keys("steps.seed.outputs.password", "", null), []);
  assertEquals(keys("inputs.x"), []);
  const { model } = modelMap({
    main: record({ password: REF_B }, pathsTag("password")),
  });
  assertEquals(
    keys(
      "model.web.resource.creds.main.attributes.user + steps.seed.outputs.user",
      "",
      steps,
      model,
    ),
    ["prod/A", "prod/B", "prod/B"],
  );
});

Deno.test("stepsView: a later group at the same path replaces the earlier one, as a repeated child step name does in the flat outputs, and a child step named __proto__ reaches nothing shared", () => {
  const repeated = sourced({}, [
    {
      path: ["deploy"],
      records: [
        source(
          "a1",
          { x: "1", password: REF_A, onlyA: "a" },
          pathsTag("password"),
        ),
      ],
    },
    {
      path: ["deploy"],
      records: [source("b1", { x: "2", token: REF_B }, pathsTag("token"))],
    },
  ]);
  runInFaultScope((scope) => {
    const view = stepsView({ call: repeated }, "") as Record<
      string,
      Record<string, Record<string, Record<string, unknown>>>
    >;
    const deploy = view.call.outputs.deploy;
    assertEquals(Object.keys(deploy).sort(), ["token", "x"]);
    assertEquals(deploy.x, "2");
    assert(isSecret(deploy.token));
    // Only the winning group's records are adapted and recorded.
    assertEquals(scope.sensitiveReferences.size, 1);
  });
  const proto = sourced({}, [{
    path: ["__proto__"],
    records: [
      source("p1", { isAdmin: "yes", password: REF_A }, pathsTag("password")),
    ],
  }]);
  runInFaultScope(() => {
    const view = stepsView({ call: proto }, "") as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const outputs = view.call.outputs;
    assertEquals(Object.getPrototypeOf(outputs), null);
    assert(Object.hasOwn(outputs, "__proto__"));
    const child = Object.getOwnPropertyDescriptor(outputs, "__proto__")!
      .value as Record<string, unknown>;
    assertEquals(child.isAdmin, "yes");
    assert(isSecret(child.password));
    assertEquals("isAdmin" in {}, false);
    assertEquals(Object.hasOwn(Object.prototype, "isAdmin"), false);
    assertEquals(Object.hasOwn(Object.prototype, "password"), false);
  });
});

Deno.test("isAdaptedView: answers true for the record view and every attribute view the adapter built, and false for the original, a plain map, a Secret and a non-object", () => {
  const original = record(
    { password: REF_A, nested: { token: REF_B, plain: "p" }, user: "u" },
    pathsTag("password", "nested.token"),
  );
  const { view } = adapt(original);
  assertEquals(isAdaptedView(view), true);
  assertEquals(isAdaptedView(attributesOf(view)), true);
  assertEquals(isAdaptedView(attributesOf(view).nested), true);
  assertEquals(isAdaptedView(original), false);
  assertEquals(isAdaptedView(original.attributes), false);
  assertEquals(isAdaptedView(attributesOf(view).password), false);
  assertEquals(isAdaptedView({ password: REF_A }), false);
  assertEquals(isAdaptedView(null), false);
  assertEquals(isAdaptedView("text"), false);
  // A record the adapter returns as it is was not built by it.
  const foreign = record({ password: REF_A }, pathsTag("password"), {
    namespace: "security",
  });
  assertEquals(isAdaptedView(adapt(foreign).view), false);
  const untagged = record({ password: REF_A });
  assertEquals(isAdaptedView(adapt(untagged).view), false);
});

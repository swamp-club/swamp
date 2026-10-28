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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { markErrorPaths, UserError } from "../errors.ts";
import {
  dispatchErrorCode,
  dispatchErrorPaths,
  DispatchParamsSchema,
  DispatchResultSchema,
  DispatchSecretLoadRequestSchema,
  EnrollParamsSchema,
  isSupportedRemoteProtocolVersion,
  LEGACY_PLAINTEXT_PROTOCOL_VERSION,
  MAX_DISPATCH_SECRET_KEY_LENGTH,
  MAX_DISPATCH_SECRET_LOAD_BODY_BYTES,
  MAX_DISPATCH_SECRET_LOADS,
  MAX_DISPATCH_SECRET_RESOURCE_NAME_LENGTH,
  MAX_DISPATCH_SECRET_VAULT_NAME_LENGTH,
  parseRpcFrame,
  plaintextFieldsOf,
  REMOTE_PROTOCOL_VERSION,
  ResolveSecretParamsSchema,
  shipsReferencesOnly,
} from "./protocol.ts";
import { SENTINEL_SOURCE } from "../vaults/secret_bag_registry.ts";

Deno.test("parseRpcFrame: returns null for non-RPC messages", () => {
  assertEquals(parseRpcFrame({ type: "workflow.run", id: "1" }), null);
  assertEquals(parseRpcFrame({ type: "event", id: "1" }), null);
  assertEquals(parseRpcFrame("hello"), null);
  assertEquals(parseRpcFrame(null), null);
  assertEquals(parseRpcFrame(42), null);
});

Deno.test("parseRpcFrame: accepts a valid request frame", () => {
  const frame = parseRpcFrame({
    type: "rpc.request",
    id: "abc",
    method: "worker.enroll",
    params: { token: "t" },
  });
  assertEquals(typeof frame, "object");
  assertEquals((frame as { type: string }).type, "rpc.request");
});

Deno.test("parseRpcFrame: accepts response, error, stream, and cancel frames", () => {
  for (
    const frame of [
      { type: "rpc.response", id: "1", result: { ok: true } },
      { type: "rpc.error", id: "1", error: { code: "x", message: "y" } },
      { type: "rpc.stream", id: "1", event: { kind: "log", line: "hi" } },
      { type: "rpc.cancel", id: "1" },
    ]
  ) {
    const parsed = parseRpcFrame(frame);
    assertEquals(typeof parsed, "object", `frame ${frame.type} should parse`);
  }
});

Deno.test("parseRpcFrame: reports malformed RPC frames as errors", () => {
  const result = parseRpcFrame({ type: "rpc.request", id: "" });
  assertEquals(typeof result, "string");
  assertStringIncludes(result as string, "Invalid RPC frame");
});

Deno.test("EnrollParamsSchema: validates a full enrollment", () => {
  const parsed = EnrollParamsSchema.parse({
    token: "tok",
    instanceUuid: "uuid-1",
    machineId: "machine-1",
    protocolVersion: 1,
    swampVersion: "1.2.3",
    platform: "linux",
    arch: "x86_64",
    labels: { region: "us-east", gpu: "true" },
  });
  assertEquals(parsed.labels.region, "us-east");
});

Deno.test("EnrollParamsSchema: labels default to empty", () => {
  const parsed = EnrollParamsSchema.parse({
    token: "tok",
    instanceUuid: "uuid-1",
    machineId: "machine-1",
    protocolVersion: 1,
    swampVersion: "1.2.3",
    platform: "linux",
    arch: "aarch64",
  });
  assertEquals(parsed.labels, {});
});

Deno.test("DispatchParamsSchema: round-trips a dispatch through JSON", () => {
  const dispatch = {
    dispatchId: "d-1",
    leaseId: "l-1",
    execution: {
      protocolVersion: 1,
      modelType: "@acme/widget",
      modelId: "m-1",
      methodName: "create",
      globalArgs: { name: "w" },
      methodArgs: { size: 3 },
      definitionMeta: { id: "m-1", name: "widget", version: 2, tags: {} },
      resourceSpecs: { out: { specName: "out" } },
    },
    bundleFingerprint: "fp-abc",
    reportBundleFingerprints: ["fp-rep"],
    environmentSnapshot: { DEPLOY_ENV: "prod" },
    dataPlaneUrl: "http://127.0.0.1:4001",
    step: { workflowName: "wf", stepName: "s1" },
  };
  const parsed = DispatchParamsSchema.parse(
    JSON.parse(JSON.stringify(dispatch)),
  );
  assertEquals(parsed.execution.methodName, "create");
  assertEquals(parsed.environmentSnapshot.DEPLOY_ENV, "prod");
  assertEquals(parsed.reportBundleFingerprints, ["fp-rep"]);
});

function dispatchWithSecretBag(sentinel: string) {
  return {
    dispatchId: "d-1",
    leaseId: "l-1",
    execution: {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      modelType: "command/shell",
      modelId: "m-1",
      methodName: "execute",
      globalArgs: {},
      methodArgs: { run: "echo s3cret" },
      definitionMeta: { id: "m-1", name: "sh", version: 1, tags: {} },
      resourceSpecs: {},
    },
    bundleFingerprint: "builtin:command/shell",
    environmentSnapshot: {},
    unresolvedMethodArgs: { run: `echo ${sentinel}` },
    secretBag: [{ sentinel, value: "s3cret", dataOrigin: false }],
  };
}

Deno.test("DispatchParamsSchema: carries the unresolved args and secret bag (swamp-club#2760)", () => {
  const sentinel = `__SWAMP_VSEC_${"0a1b2c3d".repeat(4)}_0__`;
  const parsed = DispatchParamsSchema.parse(
    JSON.parse(JSON.stringify(dispatchWithSecretBag(sentinel))),
  );
  assertEquals(parsed.unresolvedMethodArgs, { run: `echo ${sentinel}` });
  assertEquals(parsed.secretBag, [{
    sentinel,
    value: "s3cret",
    dataOrigin: false,
  }]);
  assertEquals(parsed.execution.methodArgs, { run: "echo s3cret" });
});

Deno.test("DispatchParamsSchema: a secret bag entry carries its JSON-value mark, which a worker that predates it drops (swamp-club#3967)", () => {
  const sentinel = `__SWAMP_VSEC_${"0a1b2c3d".repeat(4)}_0__`;
  const dispatch = {
    ...dispatchWithSecretBag(sentinel),
    secretBag: [{ sentinel, value: "8080", dataOrigin: true, jsonValue: true }],
  };
  const parsed = DispatchParamsSchema.parse(
    JSON.parse(JSON.stringify(dispatch)),
  );
  assertEquals(parsed.secretBag, [{
    sentinel,
    value: "8080",
    dataOrigin: true,
    jsonValue: true,
  }]);
  assertThrows(() =>
    DispatchParamsSchema.parse({
      ...dispatch,
      secretBag: [{ sentinel, value: "8080", dataOrigin: true, jsonValue: 1 }],
    })
  );
});

Deno.test("DispatchParamsSchema: rejects a malformed secret bag sentinel", () => {
  assertThrows(() =>
    DispatchParamsSchema.parse(dispatchWithSecretBag("$(touch /tmp/x)"))
  );
});

Deno.test("DispatchParamsSchema: a schema without the bag fields keeps the resolved args", () => {
  // An older worker's schema strips the fields it does not know and runs
  // the resolved args exactly as before.
  const olderSchema = DispatchParamsSchema.omit({
    unresolvedMethodArgs: true,
    secretBag: true,
  });
  const parsed = olderSchema.parse(
    dispatchWithSecretBag(`__SWAMP_VSEC_${"0a1b2c3d".repeat(4)}_0__`),
  );
  assertEquals("secretBag" in parsed, false);
  assertEquals(parsed.execution.methodArgs, { run: "echo s3cret" });
});

const minimalDispatch = {
  dispatchId: "d-1",
  leaseId: "l-1",
  execution: {
    protocolVersion: 1,
    modelType: "@acme/widget",
    modelId: "m-1",
    methodName: "create",
    globalArgs: {},
    methodArgs: {},
    definitionMeta: { id: "m-1", name: "widget", version: 2, tags: {} },
  },
  bundleFingerprint: "fp-abc",
  environmentSnapshot: {},
};

Deno.test("DispatchParamsSchema: lockHolder is optional and round-trips", () => {
  assertEquals(
    DispatchParamsSchema.parse(minimalDispatch).lockHolder,
    undefined,
  );

  const lockHolder = {
    pid: 4242,
    hostname: "host-a",
    lockIds: ["9cf79ed4-d94e-4a4c-b309-b38348ced5a5"],
  };
  const parsed = DispatchParamsSchema.parse(
    JSON.parse(JSON.stringify({ ...minimalDispatch, lockHolder })),
  );
  assertEquals(parsed.lockHolder, lockHolder);
});

Deno.test("DispatchParamsSchema: rejects a lockHolder that could forge env entries", () => {
  const valid = { pid: 4242, hostname: "host-a", lockIds: ["nonce-a"] };
  for (
    const lockHolder of [
      { ...valid, pid: 0 },
      { ...valid, pid: -1 },
      { ...valid, pid: 1.5 },
      { ...valid, pid: "4242" },
      { ...valid, hostname: "" },
      { ...valid, hostname: "h".repeat(256) },
      { ...valid, lockIds: ["a,1:b"] },
      { ...valid, lockIds: ["a+b"] },
      { ...valid, lockIds: [""] },
      { ...valid, lockIds: ["n".repeat(129)] },
      { ...valid, lockIds: Array.from({ length: 257 }, () => "nonce-a") },
    ]
  ) {
    assertEquals(
      DispatchParamsSchema.safeParse({ ...minimalDispatch, lockHolder })
        .success,
      false,
    );
  }
});

Deno.test("DispatchResultSchema: accepts success with persisted outputs", () => {
  const parsed = DispatchResultSchema.parse({
    status: "success",
    outputs: [{
      dataId: "00000000-0000-0000-0000-000000000001",
      version: 1,
      name: "out-main",
      specName: "out",
      type: "resource",
    }],
    logs: ["hello"],
    durationMs: 12,
  });
  assertEquals(parsed.outputs.length, 1);
  assertEquals(parsed.outputs[0].type, "resource");
});

Deno.test("DispatchResultSchema: strips followUpActions sent by an older worker (swamp-club#3078)", () => {
  const parsed = DispatchResultSchema.parse({
    status: "success",
    outputs: [],
    logs: [],
    durationMs: 12,
    followUpActions: [{ methodName: "poll", delayMs: 1000 }],
  });
  assertEquals(parsed.status, "success");
  assertEquals("followUpActions" in parsed, false);
});

Deno.test("DispatchResultSchema: rejects unknown output types", () => {
  const result = DispatchResultSchema.safeParse({
    status: "success",
    outputs: [{
      dataId: "x",
      version: 1,
      name: "n",
      specName: "s",
      type: "blob",
    }],
    logs: [],
    durationMs: 0,
  });
  assertEquals(result.success, false);
});

Deno.test("DispatchResultSchema: carries marked errorPaths (swamp-club#2830)", () => {
  const parsed = DispatchResultSchema.parse({
    status: "error",
    error: "cannot read /srv/acme/final report",
    errorPaths: ["/srv/acme/final report"],
    outputs: [],
    logs: [],
    durationMs: 1,
  });
  assertEquals(parsed.errorPaths, ["/srv/acme/final report"]);
});

Deno.test("DispatchResultSchema: drops out-of-bounds errorPaths without failing the result", () => {
  const base = {
    status: "error",
    error: "boom",
    outputs: [],
    logs: [],
    durationMs: 1,
  };
  for (
    const errorPaths of [
      Array.from({ length: 33 }, (_, i) => `/p/${i}`),
      ["/p/" + "x".repeat(4096)],
      [42],
      "/not/an/array",
    ]
  ) {
    const parsed = DispatchResultSchema.parse({ ...base, errorPaths });
    assertEquals(parsed.errorPaths, undefined);
    assertEquals(parsed.error, "boom");
  }
  // A result from a worker without the field still parses.
  assertEquals(DispatchResultSchema.parse(base).errorPaths, undefined);
});

Deno.test("DispatchResultSchema: carries a UserError's errorCode (swamp-club#3773)", () => {
  const parsed = DispatchResultSchema.parse({
    status: "error",
    error: "intentional failure",
    errorCode: "auth_failed",
    outputs: [],
    logs: [],
    durationMs: 1,
  });
  assertEquals(parsed.errorCode, "auth_failed");
});

Deno.test("DispatchResultSchema: drops an out-of-bounds errorCode without failing the result", () => {
  const base = {
    status: "error",
    error: "boom",
    outputs: [],
    logs: [],
    durationMs: 1,
  };
  for (const errorCode of ["", "x".repeat(129), 42, ["auth_failed"]]) {
    const parsed = DispatchResultSchema.parse({ ...base, errorCode });
    assertEquals(parsed.errorCode, undefined);
    assertEquals(parsed.error, "boom");
  }
  assertEquals(
    DispatchResultSchema.parse({ ...base, errorCode: "x".repeat(128) })
      .errorCode,
    "x".repeat(128),
  );
  // A result from a worker without the field still parses.
  assertEquals(DispatchResultSchema.parse(base).errorCode, undefined);
});

Deno.test("dispatchErrorCode: is the code of a coded UserError within the bound", () => {
  assertEquals(
    dispatchErrorCode(new UserError("denied", "auth_failed")),
    "auth_failed",
  );
  assertEquals(
    dispatchErrorCode(new UserError("denied", "x".repeat(129))),
    undefined,
  );
  assertEquals(dispatchErrorCode(new UserError("denied")), undefined);
  assertEquals(dispatchErrorCode(new Error("denied")), undefined);
  assertEquals(dispatchErrorCode("denied"), undefined);
});

Deno.test("dispatchErrorPaths: trims marked paths to what the schema accepts", () => {
  const long = "/p/" + "x".repeat(4096);
  const many = Array.from({ length: 40 }, (_, i) => `/p/${i}`);
  const error = markErrorPaths(new Error("boom"), [long, ...many]);
  const paths = dispatchErrorPaths(error);
  assertEquals(paths, many.slice(0, 32));
  const parsed = DispatchResultSchema.parse({
    status: "error",
    error: "boom",
    errorPaths: paths,
    outputs: [],
    logs: [],
    durationMs: 1,
  });
  assertEquals(parsed.errorPaths, paths);
});

Deno.test("dispatchErrorPaths: is undefined when the error marked nothing", () => {
  assertEquals(dispatchErrorPaths(new Error("boom")), undefined);
  assertEquals(dispatchErrorPaths("boom"), undefined);
});

Deno.test("REMOTE_PROTOCOL_VERSION: pins the sentinel format a dispatch's secret bag is validated against (swamp-club#3558)", () => {
  // The dispatch schema checks each shipped sentinel with SENTINEL_EXACT,
  // so a change to the format changes the wire: bump the version with it,
  // and a worker on the other side of the change is refused at enrollment
  // instead of failing on its first secret-bearing dispatch.
  assertEquals(
    [REMOTE_PROTOCOL_VERSION, SENTINEL_SOURCE],
    [6, "__SWAMP_VSEC_[0-9a-f]{32}_\\d+__"],
  );
  // A sentinel of the protocol 4 shape is refused by the schema.
  assertEquals(
    DispatchParamsSchema.safeParse(
      dispatchWithSecretBag("__SWAMP_VSEC_0a1b2c3d_0__"),
    ).success,
    false,
  );
});

Deno.test("isSupportedRemoteProtocolVersion: serve enrolls versions 5 and 6 until typed-secrets 5.3", () => {
  assertEquals(
    [4, 5, 6, 7].map(isSupportedRemoteProtocolVersion),
    [false, true, true, false],
  );
  assertEquals(LEGACY_PLAINTEXT_PROTOCOL_VERSION, 5);
  assertEquals(shipsReferencesOnly(LEGACY_PLAINTEXT_PROTOCOL_VERSION), false);
  assertEquals(shipsReferencesOnly(REMOTE_PROTOCOL_VERSION), true);
});

Deno.test("DispatchParamsSchema: a version 6 reference bag carries the reference, encoding and origin, never a value", () => {
  const sentinel = `__SWAMP_VSEC_${"0a1b2c3d".repeat(4)}_0__`;
  const { secretBag: _bag, unresolvedMethodArgs: _args, ...base } =
    dispatchWithSecretBag(sentinel);
  const entry = {
    sentinel,
    reference: { vaultName: "v", key: "k" },
    encoding: "json" as const,
    dataOrigin: true,
    jsonValue: true as const,
    location: "methodArguments.run",
  };
  const parsed = DispatchParamsSchema.parse(
    JSON.parse(JSON.stringify({
      ...base,
      execution: { ...base.execution, methodArgs: { run: `echo ${sentinel}` } },
      referenceBag: [{ ...entry, value: "s3cret" }],
    })),
  );
  // A value smuggled into an entry is stripped, never delivered.
  assertEquals(parsed.referenceBag, [entry]);
  assertEquals(plaintextFieldsOf(parsed), []);
  for (
    const bad of [
      { ...entry, sentinel: "__SWAMP_VSEC_0a1b2c3d_0__" },
      { ...entry, encoding: "base64" },
      { ...entry, reference: { vaultName: "", key: "k" } },
      {
        ...entry,
        reference: {
          vaultName: "v",
          key: "k".repeat(MAX_DISPATCH_SECRET_KEY_LENGTH + 1),
        },
      },
    ]
  ) {
    assertEquals(
      DispatchParamsSchema.safeParse({ ...base, referenceBag: [bad] }).success,
      false,
    );
  }
});

Deno.test("plaintextFieldsOf: names each plaintext-bearing field a dispatch carries", () => {
  const sentinel = `__SWAMP_VSEC_${"0a1b2c3d".repeat(4)}_0__`;
  const parsed = DispatchParamsSchema.parse({
    ...dispatchWithSecretBag(sentinel),
    secretValues: ["s3cret"],
  });
  assertEquals(plaintextFieldsOf(parsed), [
    "secretValues",
    "secretBag",
    "unresolvedMethodArgs",
  ]);
});

Deno.test("ResolveSecretParamsSchema: carries an optional resource claim (swamp-club#3529)", () => {
  const plain = ResolveSecretParamsSchema.parse({
    vaultName: "v",
    secretKey: "k",
  });
  assertEquals(plain.resource, undefined);
  const claimed = ResolveSecretParamsSchema.parse({
    vaultName: "v",
    secretKey: "k",
    resource: { name: "state-main", version: 3 },
  });
  assertEquals(claimed.resource, { name: "state-main", version: 3 });
  for (
    const resource of [{ name: "", version: 3 }, { name: "x", version: 0 }]
  ) {
    assertThrows(() =>
      ResolveSecretParamsSchema.parse({
        vaultName: "v",
        secretKey: "k",
        resource,
      })
    );
  }
});

Deno.test("DispatchSecretLoadRequestSchema: the body limit fits the largest request the schema admits", () => {
  // Characters the JSON encoder escapes to six bytes, at every bound.
  const longest = (length: number) => "\u0001".repeat(length);
  const request = {
    references: Array.from({ length: MAX_DISPATCH_SECRET_LOADS }, () => ({
      vaultName: longest(MAX_DISPATCH_SECRET_VAULT_NAME_LENGTH),
      key: longest(MAX_DISPATCH_SECRET_KEY_LENGTH),
      resource: {
        name: longest(MAX_DISPATCH_SECRET_RESOURCE_NAME_LENGTH),
        version: Number.MAX_SAFE_INTEGER,
      },
    })),
  };
  DispatchSecretLoadRequestSchema.parse(request);
  const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  assertEquals(bytes <= MAX_DISPATCH_SECRET_LOAD_BODY_BYTES, true);
});

Deno.test("DispatchSecretLoadRequestSchema: refuses unknown keys, empty requests and too many references", () => {
  const reference = { vaultName: "default", key: "k" };
  for (
    const invalid of [
      { references: [] },
      { references: [{ ...reference, value: "x" }] },
      { references: [reference], extra: true },
      {
        references: Array.from(
          { length: MAX_DISPATCH_SECRET_LOADS + 1 },
          () => reference,
        ),
      },
      { references: [{ ...reference, key: "" }] },
    ]
  ) {
    assertEquals(
      DispatchSecretLoadRequestSchema.safeParse(invalid).success,
      false,
    );
  }
});

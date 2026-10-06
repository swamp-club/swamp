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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { markErrorPaths } from "../errors.ts";
import {
  dispatchErrorPaths,
  DispatchParamsSchema,
  DispatchResultSchema,
  EnrollParamsSchema,
  parseRpcFrame,
} from "./protocol.ts";

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

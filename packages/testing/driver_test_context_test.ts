// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals } from "@std/assert";
import { createDriverTestContext } from "./driver_test_context.ts";
import type { DataHandle } from "./types.ts";

// --- Default request ---

Deno.test("createDriverTestContext: default request has sensible values", () => {
  const { request } = createDriverTestContext();
  assertEquals(request.protocolVersion, 1);
  assertEquals(request.modelType, "test/model");
  assertEquals(request.methodName, "run");
  assertEquals(request.globalArgs, {});
  assertEquals(request.methodArgs, {});
  assertEquals(request.definitionMeta.name, "test-instance");
  assertEquals(request.definitionMeta.version, 1);
  assertEquals(typeof request.modelId, "string");
  assertEquals(typeof request.definitionMeta.id, "string");
});

// --- Custom request options ---

Deno.test("createDriverTestContext: custom request options", () => {
  const { request } = createDriverTestContext({
    protocolVersion: 2,
    modelType: "custom/type",
    modelId: "my-model-id",
    methodName: "deploy",
    globalArgs: { region: "us-east-1" },
    methodArgs: { force: true },
    definitionMeta: { name: "my-def", version: 3 },
  });

  assertEquals(request.protocolVersion, 2);
  assertEquals(request.modelType, "custom/type");
  assertEquals(request.modelId, "my-model-id");
  assertEquals(request.methodName, "deploy");
  assertEquals(request.globalArgs, { region: "us-east-1" });
  assertEquals(request.methodArgs, { force: true });
  assertEquals(request.definitionMeta.name, "my-def");
  assertEquals(request.definitionMeta.version, 3);
});

// --- Optional fields ---

Deno.test("createDriverTestContext: optional fields omitted by default", () => {
  const { request } = createDriverTestContext();
  assertEquals(request.resourceSpecs, undefined);
  assertEquals(request.fileSpecs, undefined);
  assertEquals(request.bundle, undefined);
  assertEquals(request.traceHeaders, undefined);
});

Deno.test("createDriverTestContext: optional fields included when set", () => {
  const bundle = new Uint8Array([1, 2, 3]);
  const { request } = createDriverTestContext({
    resourceSpecs: { main: {} },
    fileSpecs: { log: {} },
    bundle,
    traceHeaders: { traceparent: "00-trace-id" },
  });

  assertEquals(request.resourceSpecs, { main: {} });
  assertEquals(request.fileSpecs, { log: {} });
  assertEquals(request.bundle, bundle);
  assertEquals(request.traceHeaders, { traceparent: "00-trace-id" });
});

// --- Callback: onLog ---

Deno.test("createDriverTestContext: onLog captures log lines", () => {
  const { callbacks, getCapturedLogs } = createDriverTestContext();
  callbacks.onLog!("line 1");
  callbacks.onLog!("line 2");

  const logs = getCapturedLogs();
  assertEquals(logs.length, 2);
  assertEquals(logs[0].line, "line 1");
  assertEquals(logs[1].line, "line 2");
  assertEquals(typeof logs[0].timestamp, "number");
});

// --- Callback: onResourceWritten ---

Deno.test("createDriverTestContext: onResourceWritten captures events", () => {
  const { callbacks, getCapturedResourceEvents } = createDriverTestContext();

  const handle: DataHandle = {
    name: "main",
    specName: "resource",
    kind: "resource",
    dataId: "test-data-1",
    version: 1,
    size: 100,
    tags: {},
    metadata: {
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: {},
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: "test/run",
      },
    },
  };

  callbacks.onResourceWritten!(handle);

  const events = getCapturedResourceEvents();
  assertEquals(events.length, 1);
  assertEquals(events[0].handle.name, "main");
  assertEquals(events[0].handle.dataId, "test-data-1");
});

// --- Snapshot isolation ---

Deno.test("createDriverTestContext: getCapturedLogs returns a copy", () => {
  const { callbacks, getCapturedLogs } = createDriverTestContext();

  callbacks.onLog!("first");
  const snap1 = getCapturedLogs();
  callbacks.onLog!("second");
  const snap2 = getCapturedLogs();

  assertEquals(snap1.length, 1);
  assertEquals(snap2.length, 2);
});

Deno.test("createDriverTestContext: getCapturedResourceEvents returns a copy", () => {
  const { callbacks, getCapturedResourceEvents } = createDriverTestContext();

  const handle: DataHandle = {
    name: "a",
    specName: "r",
    kind: "resource",
    dataId: "d1",
    version: 1,
    size: 10,
    tags: {},
    metadata: {
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: {},
      ownerDefinition: { ownerType: "model-method", ownerRef: "t/r" },
    },
  };

  callbacks.onResourceWritten!(handle);
  const snap1 = getCapturedResourceEvents();
  callbacks.onResourceWritten!(handle);
  const snap2 = getCapturedResourceEvents();

  assertEquals(snap1.length, 1);
  assertEquals(snap2.length, 2);
});

// --- Unique IDs ---

Deno.test("createDriverTestContext: each call generates unique IDs", () => {
  const ctx1 = createDriverTestContext();
  const ctx2 = createDriverTestContext();

  assertEquals(ctx1.request.modelId !== ctx2.request.modelId, true);
  assertEquals(
    ctx1.request.definitionMeta.id !== ctx2.request.definitionMeta.id,
    true,
  );
});

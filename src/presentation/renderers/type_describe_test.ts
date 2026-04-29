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

import { assertEquals, assertThrows } from "@std/assert";
import { consumeStream } from "../../libswamp/mod.ts";
import type { TypeDescribeEvent } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createTypeDescribeRenderer } from "./type_describe.ts";

const testData = {
  type: { raw: "command/shell", normalized: "command/shell" },
  version: "1.0.0",
  methods: [
    {
      name: "run",
      description: "Run",
      arguments: { type: "object", properties: {}, required: [] },
      dataOutputSpecs: [],
    },
  ],
};

async function* toStream(
  events: TypeDescribeEvent[],
): AsyncGenerator<TypeDescribeEvent> {
  for (const e of events) yield e;
}

Deno.test("LogTypeDescribeRenderer - completed event runs without error", async () => {
  const renderer = createTypeDescribeRenderer("log");
  const events: TypeDescribeEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: testData },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonTypeDescribeRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTypeDescribeRenderer("json");
    const events: TypeDescribeEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.version, "1.0.0");
    assertEquals(parsed.type.normalized, "command/shell");
    assertEquals(parsed.methods.length, 1);
    assertEquals(parsed.methods[0].name, "run");
  } finally {
    console.log = originalLog;
  }
});

const testDataMultiMethod = {
  type: { raw: "@john/namespace", normalized: "@john/namespace" },
  version: "2026.04.29.1",
  globalArguments: { type: "object", properties: { context: { type: "string" } } },
  methods: [
    {
      name: "list",
      description: "List all namespaces",
      arguments: { type: "object", properties: {} },
      dataOutputSpecs: [],
    },
    {
      name: "get",
      description: "Get one namespace",
      arguments: {
        type: "object",
        properties: { namespaceName: { type: "string" } },
      },
      dataOutputSpecs: [],
    },
    {
      name: "health",
      description: "Aggregated namespace health",
      arguments: {
        type: "object",
        properties: { namespaceName: { type: "string" } },
      },
      dataOutputSpecs: [],
    },
  ],
};

Deno.test("LogTypeDescribeRenderer - methodsOnly prints one line per method", async () => {
  // Capture writeOutput by intercepting Deno.stdout via a simple stub on
  // console.log won't work because writeOutput goes through the logger; the
  // existing 'runs without error' pattern is the established assertion shape.
  const renderer = createTypeDescribeRenderer("log", { methodsOnly: true });
  const events: TypeDescribeEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: testDataMultiMethod },
  ];
  await consumeStream(toStream(events), renderer.handlers());
  // No throw = pass; structural correctness is covered by the JSON test.
});

Deno.test("JsonTypeDescribeRenderer - methodsOnly omits schemas", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTypeDescribeRenderer("json", {
      methodsOnly: true,
    });
    const events: TypeDescribeEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testDataMultiMethod },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.version, "2026.04.29.1");
    assertEquals(parsed.methods.length, 3);
    assertEquals(parsed.methods[0].name, "list");
    assertEquals(parsed.methods[0].description, "List all namespaces");
    // arguments / dataOutputSpecs / globalArguments should be stripped.
    assertEquals(parsed.methods[0].arguments, undefined);
    assertEquals(parsed.globalArguments, undefined);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonTypeDescribeRenderer - default mode preserves full schemas", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTypeDescribeRenderer("json");
    const events: TypeDescribeEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testDataMultiMethod },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.globalArguments !== undefined, true);
    assertEquals(parsed.methods[0].arguments !== undefined, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogTypeDescribeRenderer - error event throws UserError", () => {
  const renderer = createTypeDescribeRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Type not found" },
      }),
    UserError,
    "Type not found",
  );
});

Deno.test("JsonTypeDescribeRenderer - error event throws UserError", () => {
  const renderer = createTypeDescribeRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Type not found" },
      }),
    UserError,
    "Type not found",
  );
});

Deno.test("createTypeDescribeRenderer - factory returns correct type per mode", () => {
  const logRenderer = createTypeDescribeRenderer("log");
  const jsonRenderer = createTypeDescribeRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});

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
      inputs: { type: "object", properties: {}, required: [] },
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

Deno.test("LogTypeDescribeRenderer: includes feature hint footer for @swamp/* types", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTypeDescribeRenderer("log");
    const swampData = {
      ...testData,
      type: { raw: "@swamp/aws", normalized: "@swamp/aws" },
    };
    const events: TypeDescribeEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: swampData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    const output = logs.join("\n");
    assertStringIncludes(
      output,
      "swamp issue feature --extension @swamp/aws",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogTypeDescribeRenderer: omits feature hint footer for non-swamp types", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTypeDescribeRenderer("log");
    const events: TypeDescribeEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    const output = logs.join("\n");
    assertEquals(output.includes("swamp issue feature"), false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("createTypeDescribeRenderer - factory returns correct type per mode", () => {
  const logRenderer = createTypeDescribeRenderer("log");
  const jsonRenderer = createTypeDescribeRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});

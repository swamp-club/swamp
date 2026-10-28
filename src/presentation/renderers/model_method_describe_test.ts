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

import { assertEquals, assertThrows } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type { CommandSurface } from "../command_surface.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import type { ModelMethodDescribeEvent } from "../../libswamp/models/method_describe.ts";
import { UserError } from "../../domain/errors.ts";
import { createModelMethodDescribeRenderer } from "./model_method_describe.ts";

const testData = {
  modelName: "my-model",
  modelType: "command/shell",
  version: "1.0.0",
  method: {
    name: "run",
    description: "Run the command",
    arguments: { type: "object", properties: {}, required: [] },
    kindSource: "none" as const,
  },
};

async function* toStream(
  events: ModelMethodDescribeEvent[],
): AsyncGenerator<ModelMethodDescribeEvent> {
  for (const e of events) yield e;
}

Deno.test("LogModelMethodDescribeRenderer - completed event runs without error", async () => {
  const renderer = createModelMethodDescribeRenderer("log");
  const events: ModelMethodDescribeEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: testData },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonModelMethodDescribeRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelMethodDescribeRenderer("json");
    const events: ModelMethodDescribeEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.modelName, "my-model");
    assertEquals(parsed.modelType, "command/shell");
    assertEquals(parsed.method.name, "run");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogModelMethodDescribeRenderer - error event throws UserError", () => {
  const renderer = createModelMethodDescribeRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Method not found" },
      }),
    UserError,
    "Method not found",
  );
});

Deno.test("JsonModelMethodDescribeRenderer - error event throws UserError", () => {
  const renderer = createModelMethodDescribeRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Method not found" },
      }),
    UserError,
    "Method not found",
  );
});

Deno.test("createModelMethodDescribeRenderer - factory returns correct type per mode", () => {
  const logRenderer = createModelMethodDescribeRenderer("log");
  const jsonRenderer = createModelMethodDescribeRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});

/** The log-mode lines for `testData`, colors stripped. */
function renderLines(surface?: CommandSurface): string[] {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    createModelMethodDescribeRenderer("log", surface).handlers().completed({
      kind: "completed",
      data: testData,
    });
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(lines.join("\n")).split("\n");
}

Deno.test("LogModelMethodDescribeRenderer - the legacy surface keeps its exact text (swamp-club#3331)", () => {
  assertEquals(renderLines(), [
    "Model: my-model",
    "Type: command/shell",
    "Version: 1.0.0",
    "",
    "Method: run - Run the command",
  ]);
  assertEquals(renderLines("model"), renderLines());
});

Deno.test("LogModelMethodDescribeRenderer - the behavior surface labels the behavior", () => {
  const lines = renderLines("behavior");
  assertEquals(lines[0], "Behavior: my-model");
  assertEquals(lines.slice(1), renderLines().slice(1));
});

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
import type { ModelGetEvent, StalenessState } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import {
  createModelGetRenderer,
  formatSchemaAttributes,
  formatSchemaType,
} from "./model_get.ts";

const testData = {
  id: "def-1",
  name: "my-model",
  type: "command/shell",
  version: 1,
  tags: {},
  globalArguments: {},
};

async function* toStream(
  events: ModelGetEvent[],
): AsyncGenerator<ModelGetEvent> {
  for (const e of events) yield e;
}

Deno.test("LogModelGetRenderer - completed event runs without error", async () => {
  const renderer = createModelGetRenderer("log");
  const events: ModelGetEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: testData },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonModelGetRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelGetRenderer("json");
    const events: ModelGetEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, "def-1");
    assertEquals(parsed.name, "my-model");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogModelGetRenderer - error event throws UserError", () => {
  const renderer = createModelGetRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Model not found" },
      }),
    UserError,
    "Model not found",
  );
});

Deno.test("JsonModelGetRenderer - error event throws UserError", () => {
  const renderer = createModelGetRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Model not found" },
      }),
    UserError,
    "Model not found",
  );
});

Deno.test("createModelGetRenderer - factory returns correct type per mode", () => {
  const logRenderer = createModelGetRenderer("log");
  const jsonRenderer = createModelGetRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});

Deno.test("LogModelGetRenderer - auto-created model runs without error", async () => {
  const renderer = createModelGetRenderer("log");
  const events: ModelGetEvent[] = [
    { kind: "resolving" },
    {
      kind: "completed",
      data: { ...testData, autoCreated: true },
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonModelGetRenderer - auto-created flag appears in JSON output", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelGetRenderer("json");
    const events: ModelGetEvent[] = [
      { kind: "resolving" },
      {
        kind: "completed",
        data: { ...testData, autoCreated: true },
      },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.autoCreated, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelGetRenderer - autoCreated absent when not set", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelGetRenderer("json");
    const events: ModelGetEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.autoCreated, undefined);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("formatSchemaType: returns undefined for undefined input", () => {
  assertEquals(formatSchemaType(undefined), undefined);
});

Deno.test("formatSchemaType: returns string unchanged for string input", () => {
  assertEquals(formatSchemaType("string"), "string");
  assertEquals(formatSchemaType("number"), "number");
  assertEquals(formatSchemaType("object"), "object");
});

Deno.test("formatSchemaType: joins array types with pipe separator", () => {
  assertEquals(formatSchemaType(["string", "null"]), "string | null");
  assertEquals(
    formatSchemaType(["string", "number", "null"]),
    "string | number | null",
  );
});

Deno.test("formatSchemaType: handles single-element arrays", () => {
  assertEquals(formatSchemaType(["string"]), "string");
});

Deno.test("formatSchemaType: handles empty arrays", () => {
  assertEquals(formatSchemaType([]), "");
});

Deno.test("formatSchemaAttributes: renders array-typed properties correctly", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      nickname: { type: ["string", "null"] },
    },
    required: ["name"],
  };
  const lines = formatSchemaAttributes(schema, "  ");
  assertEquals(lines.length, 2);
  // The first line should contain 'name' and '(string)' and '*required'
  assertEquals(lines[0].includes("name"), true);
  assertEquals(lines[0].includes("(string)"), true);
  assertEquals(lines[0].includes("*required"), true);
  // The second line should contain 'nickname' and '(string | null)'
  assertEquals(lines[1].includes("nickname"), true);
  assertEquals(lines[1].includes("(string | null)"), true);
});

// ---------------------------------------------------------------------------
// Staleness surfacing (swamp-club#900)
// ---------------------------------------------------------------------------

const staleData = {
  ...testData,
  typeVersion: "2026.01.01.1",
  currentTypeVersion: "2026.06.01.1",
  staleness: "stranded" as StalenessState,
};

async function renderLog(data: typeof testData | typeof staleData) {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    const renderer = createModelGetRenderer("log");
    await consumeStream(
      toStream([{ kind: "completed", data }] as ModelGetEvent[]),
      renderer.handlers(),
    );
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

Deno.test("LogModelGetRenderer - shows both versions when the instance is behind", async () => {
  const output = await renderLog(staleData);
  assertStringIncludes(output, "2026.01.01.1");
  assertStringIncludes(output, "2026.06.01.1");
});

Deno.test("LogModelGetRenderer - explains a stranded instance", async () => {
  const output = await renderLog(staleData);
  assertStringIncludes(output, "no upgrade entry covers the gap");
});

Deno.test("LogModelGetRenderer - says an upgradable instance will migrate", async () => {
  const output = await renderLog({ ...staleData, staleness: "upgradable" });
  assertStringIncludes(output, "next method run will migrate it");
});

Deno.test("LogModelGetRenderer - names a malformed type version and says runs will fail", async () => {
  const output = await renderLog({
    ...staleData,
    typeVersion: "1.0",
    staleness: "invalid",
  });
  // The bad value itself has to appear — `model get` is the command reached
  // for to diagnose the definition a run just failed on (swamp-club#2412).
  assertStringIncludes(output, "1.0");
  assertStringIncludes(output, "malformed");
  assertStringIncludes(output, "YYYY.MM.DD.MICRO");
  assertStringIncludes(output, "fail");
});

Deno.test("LogModelGetRenderer - stays quiet when the instance is current", async () => {
  const output = await renderLog({
    ...staleData,
    typeVersion: "2026.06.01.1",
    staleness: "current",
  });
  // No warning, and no redundant second version line.
  assertEquals(output.includes("Current Type Version:"), false);
  assertEquals(output.includes("behind its model type"), false);
});

Deno.test("JsonModelGetRenderer - carries typeVersion, currentTypeVersion and staleness", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const renderer = createModelGetRenderer("json");
    await consumeStream(
      toStream([{ kind: "completed", data: staleData }] as ModelGetEvent[]),
      renderer.handlers(),
    );
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.typeVersion, "2026.01.01.1");
    assertEquals(parsed.currentTypeVersion, "2026.06.01.1");
    assertEquals(parsed.staleness, "stranded");
  } finally {
    console.log = originalLog;
  }
});

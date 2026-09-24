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
import { stripAnsiCode } from "@std/fmt/colors";
import { consumeStream } from "../../libswamp/mod.ts";
import type { DataGetEvent } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createDataGetRenderer } from "./data_get.ts";

const testData = {
  id: "data-1",
  name: "output",
  modelId: "def-1",
  modelName: "my-model",
  modelType: "command/shell",
  version: 1,
  contentType: "application/json",
  lifetime: "run",
  garbageCollection: "run",
  streaming: false,
  tags: {},
  ownerDefinition: { ownerType: "model", ownerRef: "def-1" },
  createdAt: "2026-01-01T00:00:00.000Z",
  contentPath: ".swamp/data/output",
};

async function* toStream(
  events: DataGetEvent[],
): AsyncGenerator<DataGetEvent> {
  for (const e of events) yield e;
}

Deno.test("LogDataGetRenderer - completed event runs without error", async () => {
  const renderer = createDataGetRenderer("log");
  const events: DataGetEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: testData },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonDataGetRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createDataGetRenderer("json");
    const events: DataGetEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, "data-1");
    assertEquals(parsed.name, "output");
    assertEquals(parsed.modelName, "my-model");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogDataGetRenderer - error event throws UserError", () => {
  const renderer = createDataGetRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Data not found" },
      }),
    UserError,
    "Data not found",
  );
});

Deno.test("JsonDataGetRenderer - error event throws UserError", () => {
  const renderer = createDataGetRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Data not found" },
      }),
    UserError,
    "Data not found",
  );
});

Deno.test("createDataGetRenderer - factory returns correct type per mode", () => {
  const logRenderer = createDataGetRenderer("log");
  const jsonRenderer = createDataGetRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});

async function captureRender(
  mode: "log" | "json",
  data: DataGetEvent & { kind: "completed" },
): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const renderer = createDataGetRenderer(mode);
    await consumeStream(toStream([data]), renderer.handlers());
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs.join("\n"));
}

const binaryData = {
  ...testData,
  contentType: "image/png",
  size: 67,
  content: "iVBORw0KGgoAAAAN",
  contentEncoding: "base64" as const,
};

Deno.test("LogDataGetRenderer - binary content prints a notice, not the content", async () => {
  const output = await captureRender("log", {
    kind: "completed",
    data: binaryData,
  });
  assertStringIncludes(
    output,
    "(binary data, 67B — use --json to get it base64-encoded)",
  );
  assertEquals(output.includes(binaryData.content), false);
});

Deno.test("LogDataGetRenderer - utf-8 text content is printed as is", async () => {
  const output = await captureRender("log", {
    kind: "completed",
    data: {
      ...testData,
      contentType: "text/plain",
      content: "héllo wörld",
      contentEncoding: "utf-8",
    },
  });
  assertStringIncludes(output, "héllo wörld");
});

Deno.test("LogDataGetRenderer - content without contentEncoding (older server) prints as text", async () => {
  const output = await captureRender("log", {
    kind: "completed",
    data: { ...testData, contentType: "text/plain", content: "plain text" },
  });
  assertStringIncludes(output, "plain text");
  assertEquals(output.includes("binary data"), false);
});

Deno.test("JsonDataGetRenderer - binary content passes through as base64", async () => {
  const output = await captureRender("json", {
    kind: "completed",
    data: binaryData,
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.content, binaryData.content);
  assertEquals(parsed.contentEncoding, "base64");
  assertEquals(parsed.size, 67);
});

Deno.test("JsonDataGetRenderer - utf-8 application/json content is parsed inline", async () => {
  const output = await captureRender("json", {
    kind: "completed",
    data: { ...testData, content: '{"a":1}', contentEncoding: "utf-8" },
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.content, { a: 1 });
  assertEquals(parsed.contentEncoding, "utf-8");
});

Deno.test("JsonDataGetRenderer - base64 application/json content is not parsed", async () => {
  // "eyJhIjoxfQ==" is base64 for {"a":1}; it must stay an encoded string.
  const output = await captureRender("json", {
    kind: "completed",
    data: { ...testData, content: "eyJhIjoxfQ==", contentEncoding: "base64" },
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.content, "eyJhIjoxfQ==");
  assertEquals(parsed.contentEncoding, "base64");
});

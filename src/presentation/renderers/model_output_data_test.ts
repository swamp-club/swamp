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
import { consumeStream } from "../../libswamp/stream.ts";
import type {
  ModelOutputDataData,
  ModelOutputDataEvent,
} from "../../libswamp/models/output_data.ts";
import { createModelOutputDataRenderer } from "./model_output_data.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: ModelOutputDataEvent[],
): AsyncGenerator<ModelOutputDataEvent> {
  for (const event of events) {
    yield event;
  }
}

function makeCompletedData() {
  return {
    outputId: "abc-123",
    methodName: "start",
    dataId: "data-1",
    dataName: "result",
    version: 1,
    contentType: "application/json",
    field: null,
    data: { key: "value" },
  };
}

Deno.test("LogModelOutputDataRenderer - completed with object outputs JSON", async () => {
  const output = await captureLog("log", makeCompletedData());
  assertEquals(JSON.parse(output).key, "value");
});

Deno.test("LogModelOutputDataRenderer - completed with string outputs text", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelOutputDataRenderer("log");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: { ...makeCompletedData(), data: "plain text" },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs, ["plain text"]);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelOutputDataRenderer - completed outputs JSON", async () => {
  const parsed = JSON.parse(await captureLog("json", makeCompletedData()));
  assertEquals(parsed.outputId, "abc-123");
  assertEquals(parsed.dataName, "result");
});

Deno.test("ModelOutputDataRenderer - error throws UserError", () => {
  const renderer = createModelOutputDataRenderer("log");
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

// console.log lines and sink writes land in one ordered stream
async function captureLog(
  mode: "log" | "json",
  data: ModelOutputDataData,
  writes: number[] = [],
): Promise<string> {
  const pieces: string[] = [];
  const decoder = new TextDecoder();
  const originalLog = console.log;
  console.log = (msg: string) => pieces.push(msg + "\n");
  try {
    const renderer = createModelOutputDataRenderer(mode, {
      sink: (bytes) => {
        writes.push(bytes.length);
        pieces.push(decoder.decode(bytes));
        return Promise.resolve(bytes.length);
      },
    });
    await consumeStream(
      toStream([{ kind: "completed", data }]),
      renderer.handlers(),
    );
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(pieces.join("")).replace(/\n$/, "");
}

Deno.test("LogModelOutputDataRenderer - binary content prints a notice, not the content", async () => {
  const output = await captureLog("log", {
    ...makeCompletedData(),
    contentType: "image/png",
    contentEncoding: "base64",
    data: "iVBORw0KGgo=",
  });
  assertEquals(output, "(binary data — use --json to get it base64-encoded)");
});

Deno.test("LogModelOutputDataRenderer - utf-8 text content is printed as is", async () => {
  const output = await captureLog("log", {
    ...makeCompletedData(),
    contentType: "text/plain",
    contentEncoding: "utf-8",
    data: "héllo wörld",
  });
  assertEquals(output, "héllo wörld");
});

Deno.test("JsonModelOutputDataRenderer - binary content passes through as base64", async () => {
  const output = await captureLog("json", {
    ...makeCompletedData(),
    contentType: "image/png",
    contentEncoding: "base64",
    data: "iVBORw0KGgo=",
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.contentEncoding, "base64");
  assertEquals(parsed.data, "iVBORw0KGgo=");
});

const largeValue = {
  rows: Array.from({ length: 120_000 }, (_, i) => ({ id: i, v: `row-${i}` })),
};

Deno.test("JsonModelOutputDataRenderer: writes the bytes of JSON.stringify(value, null, 2), in bounded pieces", async () => {
  const data = { ...makeCompletedData(), data: largeValue };
  const writes: number[] = [];
  const output = await captureLog("json", data, writes);
  const expected = JSON.stringify(data, null, 2);
  assertEquals(output === expected, true, `printed ${output.length} chars`);
  assertEquals(writes.length > 50, true);
  assertEquals(writes.every((n) => n < 1024 * 1024), true);
});

Deno.test("LogModelOutputDataRenderer: prints a JSON value indented, in bounded pieces", async () => {
  const writes: number[] = [];
  const output = await captureLog(
    "log",
    { ...makeCompletedData(), data: largeValue },
    writes,
  );
  const expected = JSON.stringify(largeValue, null, 2);
  assertEquals(output === expected, true, `printed ${output.length} chars`);
  assertEquals(writes.length > 50, true);
  assertEquals(writes.every((n) => n < 1024 * 1024), true);
});

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

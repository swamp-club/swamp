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
import type { ModelGetEvent } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createModelGetRenderer } from "./model_get.ts";

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

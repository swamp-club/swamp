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
import type { ModelOutputGetEvent } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createModelOutputGetRenderer } from "./model_output_get.ts";

const testData = {
  id: "out-1",
  definitionId: "def-1",
  modelName: "my-model",
  type: "command/shell",
  methodName: "run",
  status: "completed",
  startedAt: "2026-01-01T00:00:00.000Z",
  retryCount: 0,
  provenance: {
    definitionHash: "abc",
    modelVersion: "1",
    triggeredBy: "user",
  },
};

async function* toStream(
  events: ModelOutputGetEvent[],
): AsyncGenerator<ModelOutputGetEvent> {
  for (const e of events) yield e;
}

Deno.test("LogModelOutputGetRenderer - completed event runs without error", async () => {
  const renderer = createModelOutputGetRenderer("log");
  const events: ModelOutputGetEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: testData },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonModelOutputGetRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelOutputGetRenderer("json");
    const events: ModelOutputGetEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, "out-1");
    assertEquals(parsed.modelName, "my-model");
    assertEquals(parsed.status, "completed");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogModelOutputGetRenderer - error event throws UserError", () => {
  const renderer = createModelOutputGetRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Output not found" },
      }),
    UserError,
    "Output not found",
  );
});

Deno.test("JsonModelOutputGetRenderer - error event throws UserError", () => {
  const renderer = createModelOutputGetRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Output not found" },
      }),
    UserError,
    "Output not found",
  );
});

Deno.test("createModelOutputGetRenderer - factory returns correct type per mode", () => {
  const logRenderer = createModelOutputGetRenderer("log");
  const jsonRenderer = createModelOutputGetRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});

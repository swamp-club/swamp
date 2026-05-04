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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  createDataDeleteRenderer,
  renderDataDeleteCancelled,
} from "./data_delete.ts";
import type { DataDeleteEvent } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { validationFailed } from "../../libswamp/errors.ts";

await initializeLogging({});

function captureStdout(fn: () => void): string {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

Deno.test("createDataDeleteRenderer: log mode handles full-artifact delete", () => {
  const renderer = createDataDeleteRenderer("log");
  const handlers = renderer.handlers();
  // Should not throw — log mode routes through the logger.
  handlers.completed!({
    kind: "completed",
    data: {
      modelId: "def-1",
      modelName: "my-model",
      modelType: "test/example",
      dataName: "my-data",
      version: undefined,
      versionsDeleted: 3,
    },
  });
});

Deno.test("createDataDeleteRenderer: log mode handles single-version delete", () => {
  const renderer = createDataDeleteRenderer("log");
  const handlers = renderer.handlers();
  handlers.completed!({
    kind: "completed",
    data: {
      modelId: "def-1",
      modelName: "my-model",
      modelType: "test/example",
      dataName: "my-data",
      version: 2,
      versionsDeleted: 1,
    },
  });
});

Deno.test("createDataDeleteRenderer: json mode emits envelope for full delete", () => {
  const renderer = createDataDeleteRenderer("json");
  const handlers = renderer.handlers();
  const out = captureStdout(() =>
    handlers.completed!({
      kind: "completed",
      data: {
        modelId: "def-1",
        modelName: "my-model",
        modelType: "test/example",
        dataName: "my-data",
        version: undefined,
        versionsDeleted: 3,
      },
    })
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.modelName, "my-model");
  assertEquals(parsed.dataName, "my-data");
  assertEquals(parsed.versionsDeleted, 3);
  assertEquals(parsed.version, undefined);
});

Deno.test("createDataDeleteRenderer: json mode emits envelope for --version delete", () => {
  const renderer = createDataDeleteRenderer("json");
  const handlers = renderer.handlers();
  const out = captureStdout(() =>
    handlers.completed!({
      kind: "completed",
      data: {
        modelId: "def-1",
        modelName: "my-model",
        modelType: "test/example",
        dataName: "my-data",
        version: 2,
        versionsDeleted: 1,
      },
    })
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.version, 2);
  assertEquals(parsed.versionsDeleted, 1);
});

Deno.test("createDataDeleteRenderer: error handler throws UserError", () => {
  const renderer = createDataDeleteRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error!({
        kind: "error",
        error: validationFailed("nope"),
      } as Extract<DataDeleteEvent, { kind: "error" }>),
    UserError,
    "nope",
  );
});

Deno.test("renderDataDeleteCancelled: json mode emits cancelled envelope", () => {
  const out = captureStdout(() => renderDataDeleteCancelled("json"));
  const parsed = JSON.parse(out);
  assertEquals(parsed.cancelled, true);
});

Deno.test("renderDataDeleteCancelled: log mode does not write to console.log", () => {
  const out = captureStdout(() => renderDataDeleteCancelled("log"));
  assertEquals(out, "");
});

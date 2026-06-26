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

import {
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  createDataBatchDeleteRenderer,
  createDataDeleteRenderer,
  renderDataDeleteCancelled,
} from "./data_delete.ts";
import type {
  DataBatchDeleteEvent,
  DataDeleteEvent,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { validationFailed } from "../../libswamp/errors.ts";

// noColor: true selects LogTape's text formatter, which produces a single
// pre-rendered string per record — necessary for captureLog to see the
// formatted output (the default formatter passes %c/%o placeholders that
// the terminal expands at write time, bypassing console.info mocks).
await initializeLogging({ noColor: true });

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

// LogTape's console sink routes per-level (info → console.info,
// warning → console.warn, error → console.error, etc.). Capture all
// of them and strip ANSI for stable cross-terminal assertions.
function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const [m] of originals) {
    console[m] = (...args: unknown[]) => {
      lines.push(
        args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
      );
    };
  }
  try {
    fn();
  } finally {
    for (const [m, orig] of originals) {
      console[m] = orig;
    }
  }
  // deno-lint-ignore no-control-regex
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

Deno.test("createDataDeleteRenderer: log mode handles full-artifact delete", () => {
  const renderer = createDataDeleteRenderer("log");
  const handlers = renderer.handlers();
  const out = captureLog(() =>
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
  // dataName must render with single-quote style (auto-quoted by LogTape),
  // matching the modelName/modelType interpolations on the same line. The
  // doubled-quote artifact (""my-data"") regresses issue swamp-club#230.
  assertStringIncludes(out, 'of "my-data" for');
  assertFalse(out.includes('""my-data""'), `regression: ${out}`);
});

Deno.test("createDataDeleteRenderer: log mode handles single-version delete", () => {
  const renderer = createDataDeleteRenderer("log");
  const handlers = renderer.handlers();
  const out = captureLog(() =>
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
  assertStringIncludes(out, 'of "my-data" for');
  assertFalse(out.includes('""my-data""'), `regression: ${out}`);
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

// --- Batch delete renderer tests ---

function makeBatchCompletedEvent(
  overrides: Partial<
    Extract<DataBatchDeleteEvent, { kind: "completed" }>["data"]
  > = {},
): Extract<DataBatchDeleteEvent, { kind: "completed" }> {
  return {
    kind: "completed",
    data: {
      modelId: "def-1",
      modelName: "my-model",
      modelType: "test/example",
      totalDeleted: 5,
      totalVersionsDeleted: 8,
      failed: [],
      dryRun: false,
      ...overrides,
    },
  };
}

Deno.test("createDataBatchDeleteRenderer: log mode handles real delete", () => {
  const renderer = createDataBatchDeleteRenderer("log");
  const handlers = renderer.handlers();
  const out = captureLog(() => handlers.completed!(makeBatchCompletedEvent()));
  assertStringIncludes(out, "Deleted 5 data artifact(s)");
  assertStringIncludes(out, "8 version(s)");
});

Deno.test("createDataBatchDeleteRenderer: log mode handles dry-run", () => {
  const renderer = createDataBatchDeleteRenderer("log");
  const handlers = renderer.handlers();
  const out = captureLog(() =>
    handlers.completed!(makeBatchCompletedEvent({ dryRun: true }))
  );
  assertStringIncludes(out, "Would delete 5 data artifact(s)");
});

Deno.test("createDataBatchDeleteRenderer: log mode shows partial failures", () => {
  const renderer = createDataBatchDeleteRenderer("log");
  const handlers = renderer.handlers();
  const out = captureLog(() =>
    handlers.completed!(makeBatchCompletedEvent({
      failed: [{ dataName: "bad-item", error: "permission denied" }],
    }))
  );
  assertStringIncludes(out, "1 artifact(s) failed");
  assertStringIncludes(out, "bad-item");
  assertStringIncludes(out, "permission denied");
});

Deno.test("createDataBatchDeleteRenderer: json mode emits data object", () => {
  const renderer = createDataBatchDeleteRenderer("json");
  const handlers = renderer.handlers();
  const out = captureStdout(() =>
    handlers.completed!(makeBatchCompletedEvent())
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.modelName, "my-model");
  assertEquals(parsed.totalDeleted, 5);
  assertEquals(parsed.totalVersionsDeleted, 8);
  assertEquals(parsed.dryRun, false);
  assertEquals(parsed.failed, []);
});

Deno.test("createDataBatchDeleteRenderer: error handler throws UserError", () => {
  const renderer = createDataBatchDeleteRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error!({
        kind: "error",
        error: validationFailed("batch failed"),
      } as Extract<DataBatchDeleteEvent, { kind: "error" }>),
    UserError,
    "batch failed",
  );
});

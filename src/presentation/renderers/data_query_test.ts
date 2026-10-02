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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type { DataRecord } from "../../libswamp/mod.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  createDataQueryRenderer,
  renderQueryResultsMarkdown,
} from "./data_query.ts";

function makeRecord(
  overrides: Partial<DataRecord> = {},
): DataRecord {
  return {
    id: "record-1",
    name: "result",
    version: 1,
    isLatest: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    namespace: "",
    attributes: {},
    tags: { type: "resource", specName: "result", modelName: "test" },
    modelName: "test",
    modelId: "model-1",
    modelType: "test-model",
    specName: "result",
    dataType: "resource",
    contentType: "application/json",
    lifetime: "infinite",
    ownerType: "model-method",
    streaming: false,
    size: 100,
    content: "",
    path: "",
    ownerRef: "model-1",
    workflowRunId: "",
    workflowName: "",
    jobName: "",
    stepName: "",
    source: "",
    ...overrides,
  };
}

function captureJsonOutput(
  fn: () => void,
): Record<string, unknown> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(logs[0]);
}

Deno.test("renderJson: JSON record maps attributes to content", () => {
  const renderer = createDataQueryRenderer("json");
  const handlers = renderer.handlers();

  const record = makeRecord({
    attributes: { hostname: "worker-01", os: "linux" },
    contentType: "application/json",
    content: "",
  });

  const output = captureJsonOutput(() => {
    handlers.completed({
      kind: "completed",
      data: {
        predicate: 'modelName == "test"',
        results: [record],
        total: 1,
        limited: false,
      },
    });
  });

  assertEquals(output.predicate, 'modelName == "test"');
  assertEquals(output.total, 1);
  assertEquals(output.limited, false);

  const results = output.results as Record<string, unknown>[];
  assertEquals(results.length, 1);
  assertEquals(results[0].content, { hostname: "worker-01", os: "linux" });
  assertEquals(results[0].attributes, undefined);
});

Deno.test("renderJson: non-JSON record gets empty content", () => {
  const renderer = createDataQueryRenderer("json");
  const handlers = renderer.handlers();

  const record = makeRecord({
    contentType: "text/plain",
    attributes: {},
    content: "",
  });

  const output = captureJsonOutput(() => {
    handlers.completed({
      kind: "completed",
      data: {
        predicate: 'modelName == "test"',
        results: [record],
        total: 1,
        limited: false,
      },
    });
  });

  const results = output.results as Record<string, unknown>[];
  assertEquals(results[0].content, "");
  assertEquals(results[0].attributes, undefined);
});

Deno.test("renderJson: projected query is unaffected", () => {
  const renderer = createDataQueryRenderer("json");
  const handlers = renderer.handlers();

  const output = captureJsonOutput(() => {
    handlers.completed({
      kind: "completed",
      data: {
        predicate: 'modelName == "test"',
        results: [],
        projected: {
          shape: "map",
          columns: ["name", "status"],
          rows: [{ name: "result", status: "ok" }],
        },
        total: 1,
        limited: false,
      },
    });
  });

  const results = output.results as Record<string, unknown>[];
  assertEquals(results.length, 1);
  assertEquals(results[0], { name: "result", status: "ok" });
});

Deno.test("renderJson: empty attributes produce empty content object", () => {
  const renderer = createDataQueryRenderer("json");
  const handlers = renderer.handlers();

  const record = makeRecord({
    contentType: "application/json",
    attributes: {},
    content: "",
  });

  const output = captureJsonOutput(() => {
    handlers.completed({
      kind: "completed",
      data: {
        predicate: "true",
        results: [record],
        total: 1,
        limited: false,
      },
    });
  });

  const results = output.results as Record<string, unknown>[];
  assertEquals(results[0].content, {});
  assertEquals(results[0].attributes, undefined);
});

Deno.test("renderQueryResultsMarkdown: renders more list rows than fit in a spread call", () => {
  // Math.max(...rows.map(...)) threw RangeError above ~125k rows, and data
  // query is unlimited by default (swamp-club#2565).
  const count = 150_000;
  const rows = Array.from({ length: count }, (_, i) => [i]);
  rows[count - 1] = [1, 2, 3];

  const md = renderQueryResultsMarkdown({
    predicate: "true",
    results: [],
    projected: { shape: "list", rows },
    total: count,
    limited: false,
  });

  const lines = md.split("\n");
  assertEquals(lines[0], "| 1 | 2 | 3 |");
  assertEquals(lines.length, count + 2);
});

Deno.test("renderJson: carries unresolved-model warnings in both shapes", () => {
  const warnings = ['model("missing") matched no model definition'];
  const handlers = createDataQueryRenderer("json").handlers();

  const records = captureJsonOutput(() => {
    handlers.completed({
      kind: "completed",
      data: {
        predicate: 'model("missing")',
        results: [],
        total: 0,
        limited: false,
        warnings,
      },
    });
  });
  assertEquals(records.warnings, warnings);

  const projected = captureJsonOutput(() => {
    handlers.completed({
      kind: "completed",
      data: {
        predicate: 'model("missing")',
        select: "name",
        results: [],
        projected: { shape: "scalar", values: [] },
        total: 0,
        limited: false,
        warnings,
      },
    });
  });
  assertEquals(projected.warnings, warnings);
});

Deno.test("renderJson: omits warnings when there are none", () => {
  const output = captureJsonOutput(() => {
    createDataQueryRenderer("json").handlers().completed({
      kind: "completed",
      data: { predicate: "true", results: [], total: 0, limited: false },
    });
  });
  assertEquals("warnings" in output, false);
});

Deno.test("data query log renderer: logs each warning verbatim, braces included", async () => {
  await initializeLogging({ noColor: true });
  const warning = 'model("a{b}") matched no model definition';
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const [m] of originals) {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
  }
  try {
    createDataQueryRenderer("log").handlers().completed({
      kind: "completed",
      data: {
        predicate: 'model("a{b}")',
        results: [],
        total: 0,
        limited: false,
        warnings: [warning],
      },
    });
  } finally {
    for (const [m, original] of originals) console[m] = original;
  }
  assertStringIncludes(stripAnsiCode(lines.join("\n")), warning);
});

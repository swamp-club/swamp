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
import type { DataQueryData, DataRecord } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import {
  createDataQueryRenderer,
  renderQueryResultsMarkdown,
  renderQueryResultsTerminal,
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
    garbageCollection: 10,
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

function captureJsonValue(fn: () => void): unknown {
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

function captureJsonOutput(
  fn: () => void,
): Record<string, unknown> {
  return captureJsonValue(fn) as Record<string, unknown>;
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

function renderSingle(data: DataQueryData): unknown {
  const handlers = createDataQueryRenderer("json", false, { single: true })
    .handlers();
  return captureJsonValue(() => {
    handlers.completed({ kind: "completed", data });
  });
}

Deno.test("renderJson: single prints the bare record that the envelope carries as results[0]", () => {
  const record = makeRecord({ attributes: { hostname: "worker-01" } });
  const data: DataQueryData = {
    predicate: 'name == "result"',
    results: [record],
    total: 1,
    limited: false,
  };

  const single = renderSingle(data);
  const envelope = captureJsonOutput(() => {
    createDataQueryRenderer("json").handlers().completed({
      kind: "completed",
      data,
    });
  });

  assertEquals(single, (envelope.results as unknown[])[0]);
  assertEquals(
    (single as Record<string, unknown>).content,
    { hostname: "worker-01" },
  );
});

Deno.test("renderJson: single prints a bare scalar projection", () => {
  const output = renderSingle({
    predicate: "true",
    select: "name",
    results: [],
    projected: { shape: "scalar", values: ["result"] },
    total: 1,
    limited: false,
  });

  assertEquals(output, "result");
});

Deno.test("renderJson: single prints a bare map projection", () => {
  const output = renderSingle({
    predicate: "true",
    select: "attributes",
    results: [],
    projected: {
      shape: "map",
      columns: ["status"],
      rows: [{ status: "ok" }],
    },
    total: 1,
    limited: false,
  });

  assertEquals(output, { status: "ok" });
});

Deno.test("renderJson: single prints null when the one projection failed", () => {
  const output = renderSingle({
    predicate: "true",
    select: "attributes.missing",
    results: [],
    projected: { shape: "scalar", values: [null] },
    total: 1,
    limited: false,
  });

  assertEquals(output, null);
});

Deno.test("createDataQueryRenderer: error throws UserError carrying the error code", () => {
  const handlers = createDataQueryRenderer("json", false, { single: true })
    .handlers();

  const error = assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "QUERY_NO_MATCH", message: "no match" },
      }),
    UserError,
    "no match",
  );
  assertEquals(error.code, "QUERY_NO_MATCH");
});

// Bytes 0..255 repeated: base64 using every character of its alphabet.
const BASE64_CONTENT = Uint8Array.from({ length: 3000 }, (_, i) => i % 256)
  .toBase64();

Deno.test("renderQueryResultsTerminal: base64 content survives log output unchanged", () => {
  const output = renderQueryResultsTerminal({
    predicate: 'name == "logo"',
    select: "content",
    results: [],
    projected: { shape: "scalar", values: [BASE64_CONTENT] },
    total: 1,
    limited: false,
  });
  // deno-lint-ignore no-control-regex
  assertEquals(output.replace(/\x1b\[[0-9;]*m/g, "").trim(), BASE64_CONTENT);
});

Deno.test("renderJson: projected base64 content and its encoding pass through", () => {
  const renderer = createDataQueryRenderer("json");
  const output = captureJsonOutput(() => {
    renderer.handlers().completed({
      kind: "completed",
      data: {
        predicate: 'name == "logo"',
        results: [],
        projected: {
          shape: "map",
          columns: ["content", "contentEncoding"],
          rows: [{ content: BASE64_CONTENT, contentEncoding: "base64" }],
        },
        total: 1,
        limited: false,
      },
    });
  });
  assertEquals(output.results, [
    { content: BASE64_CONTENT, contentEncoding: "base64" },
  ]);
});

function captureLines(fn: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs.join("\n"));
}

const hintData = {
  predicate: 'name == "classification"',
  results: [],
  total: 0,
  limited: false,
  specNameHint: {
    suggestedPredicate: 'specName == "classification"',
    otherFiltersDropped: false,
  },
};

Deno.test("createDataQueryRenderer: log mode prints the spec-name hint as a pasteable command", () => {
  const output = captureLines(() => {
    createDataQueryRenderer("log").handlers().completed({
      kind: "completed",
      data: hintData,
    });
  });

  assertStringIncludes(output, "No matching data found.");
  assertStringIncludes(
    output,
    "No data matched that instance name, but data with that spec name exists",
  );
  assertEquals(output.includes("not carried over"), false);
  assertStringIncludes(
    output,
    `swamp data query 'specName == "classification"'`,
  );
});

Deno.test("createDataQueryRenderer: log mode notes conditions that were not carried over", () => {
  const output = captureLines(() => {
    createDataQueryRenderer("log").handlers().completed({
      kind: "completed",
      data: {
        ...hintData,
        specNameHint: {
          ...hintData.specNameHint,
          otherFiltersDropped: true,
        },
      },
    });
  });

  assertStringIncludes(
    output,
    "(conditions other than equality checks were not carried over)",
  );
});

Deno.test("createDataQueryRenderer: log mode prints no hint without one", () => {
  const output = captureLines(() => {
    createDataQueryRenderer("log").handlers().completed({
      kind: "completed",
      data: { ...hintData, specNameHint: undefined },
    });
  });

  assertEquals(output, "No matching data found.");
});

Deno.test("renderJson: specNameHint is included only when present", () => {
  const handlers = createDataQueryRenderer("json").handlers();

  const withHint = captureJsonOutput(() => {
    handlers.completed({ kind: "completed", data: hintData });
  });
  assertEquals(withHint.specNameHint, hintData.specNameHint);

  const projected = captureJsonOutput(() => {
    handlers.completed({
      kind: "completed",
      data: {
        ...hintData,
        select: "name",
        projected: { shape: "scalar", values: [] },
      },
    });
  });
  assertEquals(projected.specNameHint, hintData.specNameHint);

  const without = captureJsonOutput(() => {
    handlers.completed({
      kind: "completed",
      data: { ...hintData, specNameHint: undefined },
    });
  });
  assertEquals("specNameHint" in without, false);
});

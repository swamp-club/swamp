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
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { consumeStream } from "../../libswamp/stream.ts";
import type { DataGetEvent } from "../../libswamp/data/get.ts";
import { UserError } from "../../domain/errors.ts";
import {
  createDataGetRenderer,
  type DataGetRenderOptions,
  renderDataGet,
  withCommandTarget,
} from "./data_get.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// noColor: true selects LogTape's text formatter, so a captured record is
// one pre-rendered string.
await initializeLogging({ noColor: true });

async function captureLog(fn: () => unknown): Promise<string> {
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
    await fn();
  } finally {
    for (const [m, orig] of originals) {
      console[m] = orig;
    }
  }
  // deno-lint-ignore no-control-regex
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

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
  const out = collectingSink();
  const renderer = createDataGetRenderer("json", { sink: out.sink });
  const events: DataGetEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: testData },
  ];
  await consumeStream(toStream(events), renderer.handlers());
  const parsed = JSON.parse(out.text());
  assertEquals(parsed.id, "data-1");
  assertEquals(parsed.name, "output");
  assertEquals(parsed.modelName, "my-model");
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

function collectingSink() {
  const parts: Uint8Array[] = [];
  return {
    writes: () => parts.map((p) => p.length),
    sink: (bytes: Uint8Array) => {
      parts.push(bytes.slice());
      return Promise.resolve(bytes.length);
    },
    text: () => {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const p of parts) {
        all.set(p, offset);
        offset += p.length;
      }
      return new TextDecoder().decode(all);
    },
  };
}

// both channels land in one ordered stream
async function captureRender(
  mode: "log" | "json",
  data: DataGetEvent & { kind: "completed" },
  options: DataGetRenderOptions = {},
): Promise<string> {
  const pieces: string[] = [];
  const decoder = new TextDecoder();
  const originalLog = console.log;
  console.log = (msg: string) => pieces.push(msg + "\n");
  try {
    const renderer = createDataGetRenderer(mode, {
      ...options,
      sink: (bytes) => {
        pieces.push(decoder.decode(bytes));
        return Promise.resolve(bytes.length);
      },
    });
    await consumeStream(toStream([data]), renderer.handlers());
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(pieces.join(""));
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

Deno.test("LogDataGetRenderer - names the behavior that owns the data", async () => {
  const output = await captureRender("log", {
    kind: "completed",
    data: testData,
  });
  assertStringIncludes(output, "Behavior: my-model (command/shell)");
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
  const output = await captureRender("json", {
    kind: "completed",
    data: { ...testData, content: "eyJhIjoxfQ==", contentEncoding: "base64" },
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.content, "eyJhIjoxfQ==");
  assertEquals(parsed.contentEncoding, "base64");
});

Deno.test("JsonDataGetRenderer: carries the deprecation warnings and replacement query", async () => {
  const replacementQuery =
    `swamp data query 'modelName == "my-model" && name == "output" && version == 1'`;
  const output = await captureRender("json", {
    kind: "completed",
    data: {
      ...testData,
      replacementQuery,
      warnings: ["swamp data get is deprecated"],
    },
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.replacementQuery, replacementQuery);
  assertEquals(parsed.warnings, ["swamp data get is deprecated"]);
});

Deno.test("LogDataGetRenderer: logs each warning verbatim, braces included", async () => {
  const warning = "swamp data get is deprecated; model {name} wrote it";
  const output = await captureLog(() =>
    createDataGetRenderer("log").handlers().completed({
      kind: "completed",
      data: { ...testData, warnings: [warning] },
    })
  );
  assertStringIncludes(output, warning);
});

Deno.test("withCommandTarget: appends the target to every query the read names", () => {
  const own = `swamp data query 'name == "output" && version == 1'`;
  const other = `swamp data query 'name == "output" && version == 2'`;
  const data = withCommandTarget({
    ...testData,
    replacementQuery: own,
    alternatives: [{
      modelName: "other",
      modelType: "command/shell",
      modelId: "id-other",
      version: 2,
      replacementQuery: other,
    }],
    warnings: [
      `Read this item with: ${own}`,
      `The others: x, read with: ${other}`,
    ],
  }, " --repo-dir /srv/repo");

  assertEquals(data.replacementQuery, `${own} --repo-dir /srv/repo`);
  assertEquals(
    data.alternatives?.[0].replacementQuery,
    `${other} --repo-dir /srv/repo`,
  );
  assertEquals(data.warnings, [
    `Read this item with: ${own} --repo-dir /srv/repo`,
    `The others: x, read with: ${other} --repo-dir /srv/repo`,
  ]);
});

Deno.test("withCommandTarget: appends the target to the latest-run query, in the field and the warning", () => {
  const pinned = `swamp data query 'workflowRunId == "run-1" && version == 1'`;
  const latest =
    `swamp data query 'workflowRunId == latestRun("wf") && version >= 0'`;
  const data = withCommandTarget({
    ...testData,
    replacementQuery: pinned,
    latestRunQuery: latest,
    warnings: [`Read this item with: ${pinned} (to follow, run: ${latest})`],
  }, " --server wss://host");

  assertEquals(data.latestRunQuery, `${latest} --server wss://host`);
  assertEquals(data.warnings, [
    `Read this item with: ${pinned} --server wss://host ` +
    `(to follow, run: ${latest} --server wss://host)`,
  ]);
});

Deno.test("withCommandTarget: a query that prefixes another is not matched inside it", () => {
  const short = `swamp data query 'name == "a"'`;
  const long = `${short} --select content`;
  const data = withCommandTarget({
    ...testData,
    replacementQuery: long,
    alternatives: [{
      modelName: "m",
      modelType: "t",
      modelId: "i",
      version: 1,
      replacementQuery: short,
    }],
    warnings: [`${long} | ${short}`],
  }, " --server wss://host");

  assertEquals(data.warnings, [
    `${long} --server wss://host | ${short} --server wss://host`,
  ]);
});

Deno.test("withCommandTarget: leaves the read unchanged without a target", () => {
  const data = { ...testData, replacementQuery: "swamp data query 'x'" };
  assertEquals(withCommandTarget(data, ""), data);
});

Deno.test("JsonDataGetRenderer: prints queries with the command target", async () => {
  const output = await captureRender("json", {
    kind: "completed",
    data: { ...testData, replacementQuery: "swamp data query 'x'" },
  }, { commandTarget: " --repo-dir /srv/repo" });
  assertEquals(
    JSON.parse(output).replacementQuery,
    "swamp data query 'x' --repo-dir /srv/repo",
  );
});

Deno.test("createDataGetRenderer: the JSON error keeps the not_found code", () => {
  const handlers = createDataGetRenderer("json").handlers();
  const message =
    "Not found: abc; runs before 2026-10-01T00:00:00.000Z have been reaped by retention (14d)";
  const error = assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: {
          code: "not_found",
          message,
          details: {
            reapedBefore: "2026-10-01T00:00:00.000Z",
            retention: "14d",
          },
        },
      }),
    UserError,
  );
  assertEquals(error.message, message);
  assertEquals(error.code, "not_found");
});

const nestedContent = {
  items: Array.from({ length: 3 }, (_, i) => ({
    id: i,
    tags: ["a", "b"],
    empty: {},
    none: [],
  })),
  text: 'quote " and newline \n',
};

Deno.test("JsonDataGetRenderer: writes the bytes of JSON.stringify(value, null, 2) and a newline", async () => {
  const data = {
    ...testData,
    content: JSON.stringify(nestedContent),
    contentEncoding: "utf-8" as const,
    warnings: ["swamp data get is deprecated"],
    replacementQuery: undefined,
  };
  const out = collectingSink();
  await createDataGetRenderer("json", { sink: out.sink }).handlers()
    .completed({ kind: "completed", data });

  const expected: Record<string, unknown> = { ...data };
  expected.content = nestedContent;
  assertEquals(out.text(), JSON.stringify(expected, null, 2) + "\n");
});

const largeContent = Array.from({ length: 120_000 }, (_, i) => ({
  id: i,
  value: `row-${i}`,
}));

Deno.test("JsonDataGetRenderer: a multi-megabyte record reaches the sink as many bounded writes", async () => {
  const out = collectingSink();
  await createDataGetRenderer("json", { sink: out.sink }).handlers()
    .completed({
      kind: "completed",
      data: {
        ...testData,
        content: JSON.stringify(largeContent),
        contentEncoding: "utf-8",
      },
    });

  const text = out.text();
  assertEquals(text.length > 4 * 1024 * 1024, true);
  assertEquals(out.writes().length > 50, true);
  assertEquals(out.writes().every((n) => n < 1024 * 1024), true);
  assertEquals(JSON.parse(text).content, largeContent);
});

Deno.test("LogDataGetRenderer: prints JSON content indented, in bounded writes", async () => {
  const out = collectingSink();
  const header = await captureLog(() =>
    createDataGetRenderer("log", { sink: out.sink }).handlers().completed({
      kind: "completed",
      data: {
        ...testData,
        content: JSON.stringify(largeContent),
        contentEncoding: "utf-8",
      },
    })
  );

  assertStringIncludes(header, "Data: output (v1)");
  // assertEquals would diff multi-megabyte strings; compare, then report
  const text = out.text();
  const expected = JSON.stringify(largeContent, null, 2) + "\n";
  assert(
    text === expected,
    `printed ${text.length} chars, not the indented ${expected.length}`,
  );
  assertEquals(out.writes().length > 50, true);
  assertEquals(out.writes().every((n) => n < 1024 * 1024), true);
});

Deno.test("LogDataGetRenderer: prints the header before JSON content", async () => {
  const output = await captureRender("log", {
    kind: "completed",
    data: { ...testData, content: '{"a":1}', contentEncoding: "utf-8" },
  });
  assertStringIncludes(output, 'Path: .swamp/data/output\n\n{\n  "a": 1\n}\n');
});

Deno.test("LogDataGetRenderer: prints unparseable JSON content once, as is", async () => {
  const content = '{"a": 1, oops';
  const output = await captureRender("log", {
    kind: "completed",
    data: { ...testData, content, contentEncoding: "utf-8" },
  });
  assertEquals(output.split(content).length - 1, 1);
});

Deno.test("renderDataGet: resolves only after the whole document is written", async () => {
  const parts: string[] = [];
  const decoder = new TextDecoder();
  await renderDataGet(
    {
      ...testData,
      content: JSON.stringify(largeContent),
      contentEncoding: "utf-8",
    },
    "json",
    {
      sink: async (bytes) => {
        await Promise.resolve();
        const taken = Math.min(bytes.length, 4096);
        parts.push(decoder.decode(bytes.subarray(0, taken), { stream: true }));
        return taken;
      },
    },
  );
  parts.push(decoder.decode());
  assertEquals(JSON.parse(parts.join("")).content, largeContent);
});

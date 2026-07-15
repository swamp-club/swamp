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

import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { LogRecord } from "@logtape/logtape";
import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context, trace } from "@opentelemetry/api";
import { withSpan } from "../tracing/tracer.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";
import { runFileSink } from "./run_file_sink.ts";
import { createOtelLogRecordSink } from "./otel_log_sink.ts";

/** Builds a LogTape LogRecord for the sink under test. */
function makeRecord(
  level: LogRecord["level"],
  message: readonly unknown[],
  properties: Record<string, unknown> = {},
  category: string[] = ["model", "method", "run", "my-model", "execute"],
): LogRecord {
  return {
    category,
    level,
    message,
    rawMessage: message.filter((p) => typeof p === "string").join(""),
    timestamp: 1719000000000,
    properties,
  } as LogRecord;
}

function newCapture(): {
  exporter: InMemoryLogRecordExporter;
  provider: LoggerProvider;
} {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider();
  provider.addLogRecordProcessor(new SimpleLogRecordProcessor(exporter));
  return { exporter, provider };
}

Deno.test("otel_log_sink: maps every LogTape level to the right SeverityNumber", () => {
  const { exporter, provider } = newCapture();
  const sink = createOtelLogRecordSink(provider);

  const cases: Array<[LogRecord["level"], SeverityNumber]> = [
    ["trace", SeverityNumber.TRACE],
    ["debug", SeverityNumber.DEBUG],
    ["info", SeverityNumber.INFO],
    ["warning", SeverityNumber.WARN],
    ["error", SeverityNumber.ERROR],
    ["fatal", SeverityNumber.FATAL],
  ];
  for (const [level] of cases) {
    sink(makeRecord(level, [`level ${level}`]));
  }

  const recs = exporter.getFinishedLogRecords();
  for (let i = 0; i < cases.length; i++) {
    assertEquals(recs[i].severityNumber, cases[i][1]);
    assertEquals(recs[i].severityText, cases[i][0].toUpperCase());
  }
});

Deno.test("otel_log_sink: renders body value-aware and sets logger.name", () => {
  const { exporter, provider } = newCapture();
  const sink = createOtelLogRecordSink(provider);

  sink(makeRecord("info", ["count is ", 42, " and obj ", { a: 1 }]));

  const rec = exporter.getFinishedLogRecords()[0];
  assertEquals(rec.body, 'count is 42 and obj {"a":1}');
  assertEquals(
    rec.attributes["logger.name"],
    "model.method.run.my-model.execute",
  );
});

Deno.test("otel_log_sink: coerces non-primitive attribute values to JSON strings", () => {
  const { exporter, provider } = newCapture();
  const sink = createOtelLogRecordSink(provider);

  sink(makeRecord("info", ["msg"], { count: 3, meta: { nested: true } }));

  const rec = exporter.getFinishedLogRecords()[0];
  assertEquals(rec.attributes.count, 3);
  assertEquals(rec.attributes.meta, '{"nested":true}');
});

Deno.test("otel_log_sink: correlates with the active span (through real withSpan)", async () => {
  const contextManager = new AsyncLocalStorageContextManager();
  context.setGlobalContextManager(contextManager);
  const tracerProvider = new BasicTracerProvider();
  tracerProvider.addSpanProcessor(
    new SimpleSpanProcessor(new InMemorySpanExporter()),
  );
  tracerProvider.register();

  const { exporter, provider } = newCapture();
  const sink = createOtelLogRecordSink(provider);

  try {
    // Outside any span — no correlation.
    sink(makeRecord("info", ["outside"]));

    let wantTrace = "";
    let wantSpan = "";
    await withSpan("swamp.model.method.run", {}, (span) => {
      wantTrace = span.spanContext().traceId;
      wantSpan = span.spanContext().spanId;
      sink(makeRecord("info", ["inside"]));
      return Promise.resolve();
    });

    const recs = exporter.getFinishedLogRecords();
    const outside = recs.find((r) => r.body === "outside");
    const inside = recs.find((r) => r.body === "inside");

    assertEquals(wantTrace.length, 32);
    assertEquals(wantSpan.length, 16);
    assertEquals(inside?.spanContext?.traceId, wantTrace);
    assertEquals(inside?.spanContext?.spanId, wantSpan);
    // The outside-span record carries no valid span context.
    assertEquals(
      outside?.spanContext?.traceId,
      undefined,
    );
  } finally {
    context.disable();
    trace.disable();
  }
});

Deno.test("otel_log_sink: redacts active-run secrets in body and string attributes", async () => {
  const { exporter, provider } = newCapture();
  const sink = createOtelLogRecordSink(provider);

  const dir = await Deno.makeTempDir();
  const redactor = new SecretRedactor();
  redactor.addSecret("top-secret-token");
  const handle = await runFileSink.register(
    [],
    `${dir}/run.log`,
    redactor,
  );

  try {
    sink(makeRecord(
      "info",
      ["auth ", "top-secret-token"],
      { token: "top-secret-token" },
    ));

    const rec = exporter.getFinishedLogRecords()[0];
    assertEquals(rec.body, "auth ***");
    assertEquals(rec.attributes.token, "***");
  } finally {
    runFileSink.unregister(handle);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("otel_log_sink: imports nothing from the tracing module (no import cycle)", async () => {
  const source = await Deno.readTextFile(
    fromFileUrl(new URL("./otel_log_sink.ts", import.meta.url)),
  );
  // Only import lines matter; the module must not reach into ../tracing.
  const importsTracing = source
    .split("\n")
    .some((line) =>
      line.trimStart().startsWith("import") && line.includes("../tracing")
    );
  assertEquals(importsTracing, false);
});

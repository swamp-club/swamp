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

// End-to-end wiring test for the OTel logs signal (swamp-club#1158). Stubs
// globalThis.fetch (no production seam needed), enables the OTLP endpoint, and
// verifies that initializeLogging routes a getSwampLogger().info() call all the
// way to a POST /v1/logs whose serialized body carries the message, the active
// span's trace/span ids, and redacted secrets — while --json stdout stays clean.
//
// Runs in its own process (each *_test.ts file does), so it may call the
// once-per-process initializeLogging() freely.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { getSwampLogger } from "../src/infrastructure/logging/logger.ts";
import { runFileSink } from "../src/infrastructure/logging/run_file_sink.ts";
import {
  initTracing,
  shutdownLogs,
  shutdownTracing,
  withSpan,
} from "../src/infrastructure/tracing/mod.ts";
import { SecretRedactor } from "../src/domain/secrets/mod.ts";

interface OtlpLogRecord {
  body?: { stringValue?: string };
  traceId?: string;
  spanId?: string;
  severityText?: string;
  attributes?: Array<{ key: string; value: { stringValue?: string } }>;
}

/** Collects every OTLP log record from all captured POSTs to /v1/logs. */
function collectLogRecords(
  captured: { url: string; body: string }[],
): OtlpLogRecord[] {
  const records: OtlpLogRecord[] = [];
  for (const { url, body } of captured) {
    if (!url.endsWith("/v1/logs")) continue;
    const payload = JSON.parse(body);
    for (const rl of payload.resourceLogs ?? []) {
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          records.push(lr as OtlpLogRecord);
        }
      }
    }
  }
  return records;
}

Deno.test("OTel logs: initializeLogging exports correlated, redacted records to /v1/logs", async () => {
  const savedEndpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const savedFetch = globalThis.fetch;
  const captured: { url: string; body: string }[] = [];

  Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  // deno-lint-ignore no-explicit-any
  globalThis.fetch = ((input: any, init: any): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    if (init?.body) {
      captured.push({
        url,
        body: new TextDecoder().decode(init.body as ArrayBuffer),
      });
    }
    return Promise.resolve(new Response(null, { status: 200 }));
    // deno-lint-ignore no-explicit-any
  }) as any;

  // Register an active run redactor so secret scrubbing is exercised.
  const tmpDir = await Deno.makeTempDir();
  const redactor = new SecretRedactor();
  redactor.addSecret("hunter2-secret-value");
  const logHandle = await runFileSink.register(
    [],
    `${tmpDir}/run.log`,
    redactor,
  );

  try {
    // initTracing registers the context manager so logs can correlate; --json
    // keeps stdout clean while logs still export (orthogonal to output mode).
    await initTracing();
    await initializeLogging({ jsonMode: true });

    const log = getSwampLogger([
      "model",
      "method",
      "run",
      "my-model",
      "execute",
    ]);

    log.info`starting up without a span`;

    let wantTrace = "";
    let wantSpan = "";
    await withSpan("swamp.model.method.run", {}, (span) => {
      wantTrace = span.spanContext().traceId;
      wantSpan = span.spanContext().spanId;
      log.info`token is ${"hunter2-secret-value"} do not leak`;
      return Promise.resolve();
    });

    // Drain in-flight exports (SimpleLogRecordProcessor + shutdown()).
    await shutdownLogs();
    await shutdownTracing();

    const records = collectLogRecords(captured);
    assert(
      records.length >= 2,
      `expected >=2 log records, got ${records.length}`,
    );

    const outside = records.find((r) =>
      r.body?.stringValue === "starting up without a span"
    );
    assert(outside, "outside-span log record was not exported");
    // No active span -> no (or zero) trace correlation.
    assert(
      !outside.traceId ||
        outside.traceId === "00000000000000000000000000000000",
      "outside-span record should not be correlated",
    );

    const inside = records.find((r) =>
      r.body?.stringValue?.startsWith("token is ")
    );
    assert(inside, "inside-span log record was not exported");
    assertEquals(inside.traceId, wantTrace);
    assertEquals(inside.spanId, wantSpan);
    assertEquals(wantTrace.length, 32);
    assertEquals(wantSpan.length, 16);
    assertEquals(inside.severityText, "INFO");
    // The secret must be scrubbed before egress.
    assertStringIncludes(inside.body!.stringValue!, "***");
    assertEquals(
      inside.body!.stringValue!.includes("hunter2-secret-value"),
      false,
    );
  } finally {
    runFileSink.unregister(logHandle);
    await Deno.remove(tmpDir, { recursive: true });
    globalThis.fetch = savedFetch;
    if (savedEndpoint === undefined) {
      Deno.env.delete("OTEL_EXPORTER_OTLP_ENDPOINT");
    } else {
      Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", savedEndpoint);
    }
  }
});

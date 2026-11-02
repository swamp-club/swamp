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

// initializeLogging routes a getSwampLogger().info() call to a POST /v1/logs
// whose body carries the message, the active span's ids and redacted secrets,
// while --json stdout stays clean

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
  const savedFetch = globalThis.fetch;
  const captured: { url: string; body: string }[] = [];

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

  const tmpDir = await Deno.makeTempDir();
  const redactor = new SecretRedactor();
  redactor.addSecret("hunter2-secret-value");
  const logHandle = await runFileSink.register(
    [],
    `${tmpDir}/run.log`,
    redactor,
  );

  try {
    // clear any stale provider so initLogs() creates a fresh one that picks up
    // the stubbed fetch
    await shutdownLogs();

    // initTracing registers the context manager so logs can correlate; the
    // endpoint is passed via config to avoid racing on Deno.env with parallel
    // tests
    await initTracing({ endpoint: "http://collector.test" });
    await initializeLogging({
      jsonMode: true,
      _reset: true,
      _logsConfig: { endpoint: "http://collector.test" },
    });

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
    assertStringIncludes(inside.body!.stringValue!, "***");
    assertEquals(
      inside.body!.stringValue!.includes("hunter2-secret-value"),
      false,
    );
  } finally {
    runFileSink.unregister(logHandle);
    await Deno.remove(tmpDir, { recursive: true });
    globalThis.fetch = savedFetch;
  }
});
